import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BrowserProfile } from "./browser-profile-store.ts";
import type { BrowserOwner, BrowserPageElement, BrowserViewport } from "./browser-session-manager.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface BrowserCapturePageState {
	url: string;
	title: string;
	elements: BrowserPageElement[];
}

export type BrowserCapturedAction =
	| { kind: "navigate"; url: string }
	| { kind: "back" | "forward" | "reload" }
	| { kind: "click"; x: number; y: number; target?: BrowserPageElement }
	| { kind: "type"; textLength: number; target?: BrowserPageElement; sensitive: boolean }
	| { kind: "scroll"; deltaX: number; deltaY: number };

export interface BrowserCaptureStep {
	id: string;
	timestamp: number;
	action: BrowserCapturedAction;
	before: BrowserCapturePageState;
	after: BrowserCapturePageState;
}

export interface BrowserWorkflowCapture {
	schema: "pi.browser-capture.v1";
	id: string;
	sessionId: string;
	owner: BrowserOwner;
	profile: BrowserProfile;
	viewport: BrowserViewport;
	status: "recording" | "stopped" | "interrupted";
	startedAt: number;
	updatedAt: number;
	initial: BrowserCapturePageState;
	steps: BrowserCaptureStep[];
}

/** Owns bounded, redacted, restart-safe evidence captured from shared browser input. */
export class BrowserWorkflowCaptureStore {
	readonly #directory: string;
	readonly #queue = new SerialOperationQueue();
	readonly #captures = new Map<string, BrowserWorkflowCapture>();
	readonly #activeBySession = new Map<string, string>();

	constructor(directory: string) {
		this.#directory = resolve(directory);
	}

	async initialize(): Promise<void> {
		await mkdir(this.#directory, { recursive: true });
		this.#captures.clear();
		this.#activeBySession.clear();
		for (const file of (await readdir(this.#directory)).filter((entry) => entry.endsWith(".json"))) {
			try {
				const capture = parseCapture(JSON.parse(await readFile(resolve(this.#directory, file), "utf8")));
				if (capture.status === "recording") {
					capture.status = "interrupted";
					capture.updatedAt = Date.now();
					await this.#persist(capture);
				}
				this.#captures.set(capture.id, capture);
			} catch {
				// Malformed captures remain unavailable until an operator removes them.
			}
		}
	}

	list(): BrowserWorkflowCapture[] {
		return [...this.#captures.values()].sort((left, right) => right.startedAt - left.startedAt).map(cloneCapture);
	}

	get(id: string): BrowserWorkflowCapture | undefined {
		const capture = this.#captures.get(id);
		return capture ? cloneCapture(capture) : undefined;
	}

	getForSession(sessionId: string): BrowserWorkflowCapture | undefined {
		const id = this.#activeBySession.get(sessionId);
		return id ? this.get(id) : undefined;
	}

	async start(input: {
		sessionId: string;
		owner: BrowserOwner;
		profile: BrowserProfile;
		viewport: BrowserViewport;
		initial: BrowserCapturePageState;
	}): Promise<BrowserWorkflowCapture> {
		return this.#queue.run(async () => {
			if (this.#activeBySession.has(input.sessionId)) throw new Error("Browser session is already recording");
			const now = Date.now();
			const capture: BrowserWorkflowCapture = {
				schema: "pi.browser-capture.v1",
				id: randomUUID(),
				sessionId: requiredString(input.sessionId, "capture.sessionId", 128),
				owner: normalizeOwner(input.owner),
				profile: normalizeProfile(input.profile),
				viewport: normalizeViewport(input.viewport),
				status: "recording",
				startedAt: now,
				updatedAt: now,
				initial: normalizePageState(input.initial),
				steps: [],
			};
			await this.#persist(capture);
			this.#captures.set(capture.id, capture);
			this.#activeBySession.set(capture.sessionId, capture.id);
			return cloneCapture(capture);
		});
	}

	async record(sessionId: string, input: Omit<BrowserCaptureStep, "id" | "timestamp">): Promise<void> {
		await this.#queue.run(async () => {
			const id = this.#activeBySession.get(sessionId);
			if (!id) return;
			const capture = this.#captures.get(id);
			if (!capture || capture.status !== "recording") return;
			if (capture.steps.length >= 200) {
				capture.status = "stopped";
				capture.updatedAt = Date.now();
				this.#activeBySession.delete(sessionId);
				await this.#persist(capture);
				return;
			}
			const step: BrowserCaptureStep = {
				id: `step-${capture.steps.length + 1}`,
				timestamp: Date.now(),
				action: normalizeAction(input.action),
				before: normalizePageState(input.before),
				after: normalizePageState(input.after),
			};
			if (step.action.kind === "scroll") {
				const previous = capture.steps.at(-1);
				if (previous?.action.kind === "scroll" && step.timestamp - previous.timestamp < 750) {
					previous.action.deltaX += step.action.deltaX;
					previous.action.deltaY += step.action.deltaY;
					previous.after = step.after;
					previous.timestamp = step.timestamp;
					capture.updatedAt = step.timestamp;
					await this.#persist(capture);
					return;
				}
			}
			if (step.action.kind === "type") {
				const previous = capture.steps.at(-1);
				if (
					previous?.action.kind === "type" &&
					step.timestamp - previous.timestamp < 750 &&
					JSON.stringify(previous.action.target) === JSON.stringify(step.action.target)
				) {
					previous.action.textLength += step.action.textLength;
					previous.action.sensitive ||= step.action.sensitive;
					previous.after = step.after;
					previous.timestamp = step.timestamp;
					capture.updatedAt = step.timestamp;
					await this.#persist(capture);
					return;
				}
			}
			capture.steps.push(step);
			capture.updatedAt = step.timestamp;
			await this.#persist(capture);
		});
	}

	async stop(sessionId: string): Promise<BrowserWorkflowCapture> {
		return this.#queue.run(async () => {
			const id = this.#activeBySession.get(sessionId);
			if (!id) throw new Error("Browser session is not recording");
			const capture = this.#captures.get(id);
			if (!capture) throw new Error("Browser capture was not found");
			capture.status = "stopped";
			capture.updatedAt = Date.now();
			this.#activeBySession.delete(sessionId);
			await this.#persist(capture);
			return cloneCapture(capture);
		});
	}

	async interrupt(sessionId: string): Promise<BrowserWorkflowCapture | undefined> {
		return this.#queue.run(async () => {
			const id = this.#activeBySession.get(sessionId);
			if (!id) return undefined;
			const capture = this.#captures.get(id);
			this.#activeBySession.delete(sessionId);
			if (!capture || capture.status !== "recording") return undefined;
			capture.status = "interrupted";
			capture.updatedAt = Date.now();
			await this.#persist(capture);
			return cloneCapture(capture);
		});
	}

	async #persist(capture: BrowserWorkflowCapture): Promise<void> {
		await writeAtomic(resolve(this.#directory, `${capture.id}.json`), `${JSON.stringify(capture, null, 2)}\n`);
	}
}

function parseCapture(value: unknown): BrowserWorkflowCapture {
	const input = object(value, "browser capture");
	if (input.schema !== "pi.browser-capture.v1") throw new Error("Unsupported browser capture schema");
	if (!Array.isArray(input.steps)) throw new Error("capture.steps must be an array");
	return {
		schema: "pi.browser-capture.v1",
		id: requiredString(input.id, "capture.id", 128),
		sessionId: requiredString(input.sessionId, "capture.sessionId", 128),
		owner: normalizeOwner(input.owner),
		profile: normalizeProfile(input.profile ?? { kind: "ephemeral" }),
		viewport: normalizeViewport(input.viewport),
		status: oneOf(input.status, ["recording", "stopped", "interrupted"], "capture.status"),
		startedAt: timestamp(input.startedAt, "capture.startedAt"),
		updatedAt: timestamp(input.updatedAt, "capture.updatedAt"),
		initial: normalizePageState(input.initial),
		steps: input.steps.map((entry, index) => {
			const step = object(entry, `capture.steps[${index}]`);
			return {
				id: requiredString(step.id, "capture step id", 128),
				timestamp: timestamp(step.timestamp, "capture step timestamp"),
				action: normalizeAction(step.action),
				before: normalizePageState(step.before),
				after: normalizePageState(step.after),
			};
		}),
	};
}

function normalizeAction(value: unknown): BrowserCapturedAction {
	const input = object(value, "captured action");
	const kind = oneOf(input.kind, ["navigate", "back", "forward", "reload", "click", "type", "scroll"], "action.kind");
	switch (kind) {
		case "navigate":
			return { kind, url: requiredString(input.url, "action.url", 4_000) };
		case "back":
		case "forward":
		case "reload":
			return { kind };
		case "click":
			return {
				kind,
				x: finiteNumber(input.x, "action.x"),
				y: finiteNumber(input.y, "action.y"),
				target: input.target === undefined ? undefined : normalizeElement(input.target),
			};
		case "type":
			return {
				kind,
				textLength: positiveInteger(input.textLength, "action.textLength", 100_000),
				target: input.target === undefined ? undefined : normalizeElement(input.target),
				sensitive: requiredBoolean(input.sensitive, "action.sensitive"),
			};
		case "scroll":
			return {
				kind,
				deltaX: finiteNumber(input.deltaX, "action.deltaX"),
				deltaY: finiteNumber(input.deltaY, "action.deltaY"),
			};
	}
}

function normalizePageState(value: unknown): BrowserCapturePageState {
	const input = object(value, "capture page state");
	if (!Array.isArray(input.elements)) throw new Error("capture page elements must be an array");
	return {
		url: requiredString(input.url, "page.url", 4_000),
		title: typeof input.title === "string" ? input.title.slice(0, 1_000) : "",
		elements: input.elements.slice(0, 300).map(normalizeElement),
	};
}

function normalizeElement(value: unknown): BrowserPageElement {
	const input = object(value, "browser page element");
	return {
		role: requiredString(input.role, "element.role", 80),
		name: typeof input.name === "string" ? input.name.slice(0, 240) : "",
		tag: optionalString(input.tag, 80),
		label: optionalString(input.label, 240),
		testId: optionalString(input.testId, 240),
		id: optionalString(input.id, 240),
		inputType: optionalString(input.inputType, 80),
		visible: optionalBoolean(input.visible),
		enabled: optionalBoolean(input.enabled),
		frame:
			input.frame === undefined
				? undefined
				: array(input.frame, "element.frame", 16).map((entry, index) => {
						const frame = object(entry, `element.frame[${index}]`);
						return {
							name: typeof frame.name === "string" ? frame.name.slice(0, 240) : "",
							url: requiredString(frame.url, `element.frame[${index}].url`, 4_000),
						};
					}),
	};
}

function normalizeOwner(value: unknown): BrowserOwner {
	const input = object(value, "capture owner");
	return {
		kind: oneOf(input.kind, ["pi-session", "agent-run", "external-run"], "capture.owner.kind"),
		id: requiredString(input.id, "capture.owner.id", 128),
	};
}

function normalizeProfile(value: unknown): BrowserProfile {
	const input = object(value, "capture profile");
	const kind = oneOf(input.kind, ["ephemeral", "named"], "capture.profile.kind");
	if (kind === "ephemeral") return { kind };
	const id = requiredString(input.id, "capture.profile.id", 64);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("capture.profile.id is invalid");
	return { kind, id };
}

function normalizeViewport(value: unknown): BrowserViewport {
	const input = object(value, "capture viewport");
	return {
		width: positiveInteger(input.width, "viewport.width", 7_680),
		height: positiveInteger(input.height, "viewport.height", 4_320),
		deviceScaleFactor: positiveNumber(input.deviceScaleFactor, "viewport.deviceScaleFactor", 4),
	};
}

function cloneCapture(capture: BrowserWorkflowCapture): BrowserWorkflowCapture {
	return structuredClone(capture);
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, name: string, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${name} must be a bounded array`);
	return value;
}

function requiredString(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	const result = value.trim();
	if (result.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
	return result;
}

function optionalString(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.trim().slice(0, maximum);
}

function requiredBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
	return value;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return Number(value);
}

function positiveNumber(value: unknown, name: string, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be positive and no greater than ${maximum}`);
	}
	return value;
}

function timestamp(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a timestamp`);
	return Number(value);
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	}
	return value as T;
}
