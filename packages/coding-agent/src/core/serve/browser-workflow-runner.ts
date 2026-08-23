import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BrowserProfile } from "./browser-profile-store.ts";
import type {
	BrowserOwner,
	BrowserPageElement,
	BrowserRuntimeKind,
	BrowserSessionManager,
	BrowserWorkspace,
} from "./browser-session-manager.ts";
import type {
	BrowserAssertion,
	BrowserLocatorCandidate,
	BrowserTarget,
	BrowserValue,
	BrowserWorkflowDefinition,
	BrowserWorkflowRegistry,
	BrowserWorkflowStep,
} from "./browser-workflow-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type BrowserWorkflowRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface BrowserWorkflowRunStep {
	stepId: string;
	status: "completed" | "failed";
	startedAt: number;
	completedAt: number;
	url?: string;
	error?: string;
	artifacts: Array<{ id: string; kind: "screenshot"; size: number; phase: "before" | "after" | "failure" }>;
}

export interface BrowserWorkflowRun {
	schema: "pi.browser-workflow-run.v1";
	id: string;
	kind: "validation" | "execution";
	workflowId: string;
	workflowVersion: number;
	workflowDigest: string;
	owner: BrowserOwner;
	status: BrowserWorkflowRunStatus;
	parameterNames: string[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	steps: BrowserWorkflowRunStep[];
	error?: string;
}

export interface BrowserWorkflowRunInput {
	owner: BrowserOwner;
	workspace: BrowserWorkspace;
	parameters: Record<string, string | number | boolean>;
	profile?: BrowserProfile;
	runtime?: BrowserRuntimeKind;
	approved?: boolean;
}

export interface BrowserWorkflowExecution {
	runId: string;
	completion: Promise<BrowserWorkflowRun>;
	cancel(): Promise<void>;
}

/** Replays canonical browser workflows in isolated contexts and records restart-safe evidence. */
export class BrowserWorkflowRunner {
	readonly #registry: BrowserWorkflowRegistry;
	readonly #manager: BrowserSessionManager;
	readonly #runDirectory: string;
	readonly #queue = new SerialOperationQueue();
	readonly #runs = new Map<string, BrowserWorkflowRun>();
	readonly #activeSessions = new Map<string, string>();
	readonly #activeControllers = new Map<string, AbortController>();

	constructor(registry: BrowserWorkflowRegistry, manager: BrowserSessionManager, runDirectory: string) {
		this.#registry = registry;
		this.#manager = manager;
		this.#runDirectory = resolve(runDirectory);
	}

	async initialize(): Promise<void> {
		await mkdir(this.#runDirectory, { recursive: true });
		this.#runs.clear();
		for (const file of (await readdir(this.#runDirectory)).filter((entry) => entry.endsWith(".json"))) {
			try {
				const run = parseRun(JSON.parse(await readFile(resolve(this.#runDirectory, file), "utf8")));
				if (run.status === "running") {
					run.status = "interrupted";
					run.error = "Pi stopped before the browser workflow completed";
					run.updatedAt = Date.now();
					run.completedAt = run.updatedAt;
					await this.#persist(run);
				}
				this.#runs.set(run.id, run);
			} catch {
				// Invalid run evidence is not exposed or overwritten.
			}
		}
	}

	list(workflowId?: string): BrowserWorkflowRun[] {
		return [...this.#runs.values()]
			.filter((run) => workflowId === undefined || run.workflowId === workflowId)
			.sort((left, right) => right.startedAt - left.startedAt)
			.map((run) => structuredClone(run));
	}

	get(runId: string): BrowserWorkflowRun | undefined {
		const run = this.#runs.get(runId);
		return run ? structuredClone(run) : undefined;
	}

	isActiveVersion(id: string, version: number): boolean {
		return this.#registry.getActive(id)?.version === version;
	}

	async validate(id: string, version: number, input: BrowserWorkflowRunInput): Promise<BrowserWorkflowRun> {
		const workflow = this.#registry.get(id, version);
		if (!workflow) throw new Error(`Browser workflow ${id} version ${version} was not found`);
		if (workflow.status !== "compiled") {
			throw new Error("Only compiled browser workflows can be validated");
		}
		const run = await this.#run(workflow, input, "validation");
		if (run.status === "completed") {
			await this.#registry.markValidated(workflow.id, workflow.version, {
				id: run.id,
				digest: workflow.digest,
				completedAt: run.completedAt!,
			});
		}
		return run;
	}

	async execute(id: string, input: BrowserWorkflowRunInput): Promise<BrowserWorkflowRun> {
		return (await this.startExecute(id, input)).completion;
	}

	async executeVersion(id: string, version: number, input: BrowserWorkflowRunInput): Promise<BrowserWorkflowRun> {
		return (await this.startExecute(id, input, version)).completion;
	}

	async startExecute(id: string, input: BrowserWorkflowRunInput, version?: number): Promise<BrowserWorkflowExecution> {
		const workflow = this.#registry.getActive(id);
		if (!workflow) throw new Error(`Active browser workflow ${id} was not found`);
		if (version !== undefined && workflow.version !== version) {
			throw new Error(`Browser workflow ${id} version ${version} is not the active validated version`);
		}
		const runId = randomUUID();
		const controller = new AbortController();
		this.#activeControllers.set(runId, controller);
		const completion = this.#run(workflow, input, "execution", runId, controller.signal).finally(() => {
			this.#activeControllers.delete(runId);
		});
		return {
			runId,
			completion,
			cancel: () => this.cancel(runId),
		};
	}

	async cancel(runId: string): Promise<void> {
		const controller = this.#activeControllers.get(runId);
		if (!controller) throw new Error(`Running browser workflow ${runId} was not found`);
		controller.abort();
		const sessionId = this.#activeSessions.get(runId);
		if (sessionId) await this.#manager.close(sessionId);
	}

	async #run(
		workflow: BrowserWorkflowDefinition,
		input: BrowserWorkflowRunInput,
		kind: "validation" | "execution",
		runId = randomUUID(),
		signal?: AbortSignal,
	): Promise<BrowserWorkflowRun> {
		const parameters = validateParameters(workflow, input.parameters);
		if (kind === "execution" && workflow.policy.approval === "always" && input.approved !== true) {
			throw new Error("This browser workflow requires explicit approval before execution");
		}
		if (workflow.requirements.profile === "authenticated" && input.profile?.kind !== "named") {
			throw new Error("This workflow requires an explicit named browser profile");
		}
		const now = Date.now();
		const run: BrowserWorkflowRun = {
			schema: "pi.browser-workflow-run.v1",
			id: runId,
			kind,
			workflowId: workflow.id,
			workflowVersion: workflow.version,
			workflowDigest: workflow.digest,
			owner: { ...input.owner },
			status: "running",
			parameterNames: Object.keys(parameters).sort(),
			startedAt: now,
			updatedAt: now,
			steps: [],
		};
		await this.#save(run);
		let sessionId: string | undefined;
		const deadlineAt = run.startedAt + workflow.policy.deadlineMs;
		try {
			throwIfAborted(signal);
			const session = await this.#manager.create({
				owner: input.owner,
				workspace: input.workspace,
				access: workflow.requirements.access,
				runtime: input.runtime,
				profile: workflow.requirements.profile === "none" ? { kind: "ephemeral" } : input.profile,
				viewport: workflow.requirements.viewport,
			});
			sessionId = session.id;
			this.#activeSessions.set(run.id, session.id);
			throwIfAborted(signal);
			const entryUrl = substitute(workflow.entry.urlTemplate, parameters);
			assertOrigin(entryUrl, workflow.entry.allowedOrigins);
			await deadline(
				this.#manager.navigate(session.id, entryUrl),
				remainingTime(deadlineAt),
				"Workflow deadline exceeded",
			);
			await assertAll(
				this.#manager,
				session.id,
				workflow.entry.ready,
				Math.min(30_000, remainingTime(deadlineAt)),
				signal,
			);
			for (const step of workflow.steps) {
				throwIfAborted(signal);
				await this.#runStep(run, session.id, step, parameters, workflow.entry.allowedOrigins, deadlineAt, signal);
			}
			await assertAll(
				this.#manager,
				session.id,
				workflow.completion,
				Math.min(30_000, remainingTime(deadlineAt)),
				signal,
			);
			run.status = "completed";
		} catch (error) {
			run.status = signal?.aborted ? "cancelled" : "failed";
			run.error = message(error);
		} finally {
			this.#activeSessions.delete(run.id);
			if (sessionId) await this.#manager.close(sessionId).catch(() => {});
			run.updatedAt = Date.now();
			run.completedAt = run.updatedAt;
			await this.#save(run);
		}
		return structuredClone(run);
	}

	async #runStep(
		run: BrowserWorkflowRun,
		sessionId: string,
		step: BrowserWorkflowStep,
		parameters: Record<string, string | number | boolean>,
		allowedOrigins: string[],
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<void> {
		const startedAt = Date.now();
		const timeoutMs = Math.min(step.timeoutMs, remainingTime(deadlineAt));
		const artifacts: BrowserWorkflowRunStep["artifacts"] = [];
		try {
			await assertAll(this.#manager, sessionId, step.preconditions, timeoutMs, signal);
			if (step.evidence === "before-after") {
				const before = (await this.#manager.captureScreenshotArtifact(sessionId)).artifact;
				if (before) artifacts.push({ id: before.id, kind: before.kind, size: before.size, phase: "before" });
			}
			await deadline(
				executeStep(this.#manager, sessionId, step, parameters, allowedOrigins, signal),
				timeoutMs,
				`${step.id} timed out`,
			);
			await assertAll(
				this.#manager,
				sessionId,
				step.postconditions,
				Math.min(timeoutMs, remainingTime(deadlineAt)),
				signal,
			);
			if (step.evidence === "before-after") {
				const after = (await this.#manager.captureScreenshotArtifact(sessionId)).artifact;
				if (after) artifacts.push({ id: after.id, kind: after.kind, size: after.size, phase: "after" });
			}
			const snapshot = await this.#manager.snapshot(sessionId);
			run.steps.push({
				stepId: step.id,
				status: "completed",
				startedAt,
				completedAt: Date.now(),
				url: snapshot.url,
				artifacts,
			});
		} catch (error) {
			if (step.evidence !== "none") {
				const failure = await this.#manager.captureScreenshotArtifact(sessionId).catch(() => undefined);
				if (failure?.artifact) {
					artifacts.push({
						id: failure.artifact.id,
						kind: failure.artifact.kind,
						size: failure.artifact.size,
						phase: "failure",
					});
				}
			}
			run.steps.push({
				stepId: step.id,
				status: "failed",
				startedAt,
				completedAt: Date.now(),
				url: this.#manager.get(sessionId)?.url,
				error: message(error),
				artifacts,
			});
			throw error;
		} finally {
			run.updatedAt = Date.now();
			await this.#save(run);
		}
	}

	async #save(run: BrowserWorkflowRun): Promise<void> {
		await this.#queue.run(async () => {
			await this.#persist(run);
			this.#runs.set(run.id, structuredClone(run));
		});
	}

	async #persist(run: BrowserWorkflowRun): Promise<void> {
		await writeAtomic(resolve(this.#runDirectory, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
	}
}

async function executeStep(
	manager: BrowserSessionManager,
	sessionId: string,
	step: BrowserWorkflowStep,
	parameters: Record<string, string | number | boolean>,
	allowedOrigins: string[],
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	switch (step.action) {
		case "navigate": {
			const url = substitute(step.urlTemplate, parameters);
			assertOrigin(url, allowedOrigins);
			await manager.navigate(sessionId, url);
			return;
		}
		case "click": {
			const reference = await resolveTarget(manager, sessionId, step.target);
			await manager.click(sessionId, reference.revision, reference.ref);
			return;
		}
		case "fill": {
			const reference = await resolveTarget(manager, sessionId, step.target);
			await manager.fill(sessionId, reference.revision, reference.ref, resolveValue(step.value, parameters));
			return;
		}
		case "select": {
			const reference = await resolveTarget(manager, sessionId, step.target);
			await manager.select(sessionId, reference.revision, reference.ref, resolveValue(step.value, parameters));
			return;
		}
		case "scroll-to": {
			const reference = await resolveTarget(manager, sessionId, step.target);
			await manager.scrollIntoView(sessionId, reference.revision, reference.ref);
			return;
		}
		case "press":
			if (step.target) {
				const reference = await resolveTarget(manager, sessionId, step.target);
				await manager.click(sessionId, reference.revision, reference.ref);
			}
			await manager.press(sessionId, step.key);
			return;
		case "wait":
			await waitForAssertion(manager, sessionId, step.assertion, step.timeoutMs, signal);
			return;
		case "assert":
			await assertOne(manager, sessionId, step.assertion);
	}
}

async function assertAll(
	manager: BrowserSessionManager,
	sessionId: string,
	assertions: BrowserAssertion[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	for (const assertion of assertions) await waitForAssertion(manager, sessionId, assertion, timeoutMs, signal);
}

async function waitForAssertion(
	manager: BrowserSessionManager,
	sessionId: string,
	assertion: BrowserAssertion,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown;
	while (Date.now() - startedAt <= timeoutMs) {
		throwIfAborted(signal);
		try {
			await assertOne(manager, sessionId, assertion);
			return;
		} catch (error) {
			lastError = error;
			await new Promise<void>((complete) => setTimeout(complete, 100));
		}
	}
	throwIfAborted(signal);
	throw lastError ?? new Error("Browser assertion timed out");
}

async function assertOne(
	manager: BrowserSessionManager,
	sessionId: string,
	assertion: BrowserAssertion,
): Promise<void> {
	const session = manager.get(sessionId);
	if (!session) throw new Error("Browser session was closed");
	switch (assertion.kind) {
		case "page-ready":
			if (session.status !== "ready") throw new Error("Browser page is not ready");
			return;
		case "url":
			if (!new RegExp(assertion.pattern).test((await manager.snapshot(sessionId)).url))
				throw new Error("Browser URL assertion failed");
			return;
		case "title":
			if (!new RegExp(assertion.pattern).test((await manager.snapshot(sessionId)).title))
				throw new Error("Browser title assertion failed");
			return;
		case "element": {
			const snapshot = await manager.snapshot(sessionId);
			const element = findTarget(snapshot.elements, assertion.target);
			if (assertion.state === "hidden") {
				if (element?.visible !== false && element !== undefined)
					throw new Error("Expected browser element to be hidden");
				return;
			}
			if (!element) throw new Error("Expected browser element was not found");
			if (assertion.state === "visible" && element.visible === false)
				throw new Error("Expected browser element to be visible");
			if (assertion.state === "enabled" && element.enabled === false)
				throw new Error("Expected browser element to be enabled");
			if (assertion.state === "disabled" && element.enabled !== false)
				throw new Error("Expected browser element to be disabled");
			return;
		}
		case "text": {
			const snapshot = await manager.snapshot(sessionId);
			const found = snapshot.elements.some((element) => element.name.includes(assertion.text));
			if (found !== assertion.visible) throw new Error("Browser text assertion failed");
			return;
		}
		case "download":
			if (
				!manager
					.downloads(sessionId)
					.some(
						(download) =>
							assertion.namePattern === undefined || new RegExp(assertion.namePattern).test(download.name),
					)
			) {
				throw new Error("Expected browser download was not observed");
			}
			return;
	}
}

async function resolveTarget(
	manager: BrowserSessionManager,
	sessionId: string,
	target: BrowserTarget,
): Promise<{ revision: number; ref: string }> {
	const snapshot = await manager.snapshot(sessionId);
	const element = findTarget(snapshot.elements, target);
	if (!element) throw new Error("Browser target did not resolve uniquely");
	return { revision: snapshot.revision, ref: element.ref };
}

function findTarget<T extends BrowserPageElement>(elements: T[], target: BrowserTarget): T | undefined {
	for (const candidate of target.candidates) {
		const matches = elements.filter(
			(element) =>
				matchesFrame(element, target) && matchesCandidate(element, candidate) && matchesExpected(element, target),
		);
		if (matches.length === 1) return matches[0];
	}
	return undefined;
}

function matchesFrame(element: BrowserPageElement, target: BrowserTarget): boolean {
	const frames = element.frame ?? [];
	if (frames.length !== target.frame.length) return false;
	return target.frame.every((expected, index) => {
		const actual = frames[index];
		return (
			actual !== undefined &&
			(expected.name === undefined || actual.name === expected.name) &&
			(expected.urlPattern === undefined || new RegExp(expected.urlPattern).test(actual.url))
		);
	});
}

function matchesCandidate(element: BrowserPageElement, candidate: BrowserLocatorCandidate): boolean {
	switch (candidate.kind) {
		case "test-id":
			return element.testId === candidate.value;
		case "id":
			return element.id === candidate.value;
		case "label":
			return candidate.exact ? element.label === candidate.text : element.label?.includes(candidate.text) === true;
		case "text":
			return candidate.exact ? element.name === candidate.text : element.name.includes(candidate.text);
		case "role":
			return (
				element.role === candidate.role &&
				(candidate.exact ? element.name === candidate.name : element.name.includes(candidate.name))
			);
	}
}

function matchesExpected(element: BrowserPageElement, target: BrowserTarget): boolean {
	return (
		(target.expected.tag === undefined || element.tag === target.expected.tag) &&
		(target.expected.role === undefined || element.role === target.expected.role) &&
		(target.expected.inputType === undefined || element.inputType === target.expected.inputType)
	);
}

function validateParameters(
	workflow: BrowserWorkflowDefinition,
	values: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const parameter of workflow.parameters) {
		const value = values[parameter.name] ?? parameter.default;
		if (value === undefined) {
			if (parameter.required) throw new Error(`Missing browser workflow parameter ${parameter.name}`);
			continue;
		}
		if (parameter.type === "number" && typeof value !== "number")
			throw new Error(`${parameter.name} must be a number`);
		if (parameter.type === "boolean" && typeof value !== "boolean")
			throw new Error(`${parameter.name} must be a boolean`);
		if (parameter.type === "secret-ref") {
			if (typeof value !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
				throw new Error(`${parameter.name} must be an env:NAME secret reference`);
			}
			const secret = process.env[value.slice("env:".length)];
			if (secret === undefined) throw new Error(`Secret reference for ${parameter.name} is unavailable`);
			result[parameter.name] = secret;
			continue;
		}
		if (!["number", "boolean"].includes(parameter.type) && typeof value !== "string") {
			throw new Error(`${parameter.name} must be a string`);
		}
		if (parameter.choices && !parameter.choices.includes(String(value))) {
			throw new Error(`${parameter.name} must be one of: ${parameter.choices.join(", ")}`);
		}
		result[parameter.name] = value;
	}
	return result;
}

function resolveValue(value: BrowserValue, parameters: Record<string, string | number | boolean>): string {
	return value.kind === "constant" ? value.value : String(parameters[value.name]);
}

function substitute(template: string, parameters: Record<string, string | number | boolean>): string {
	return template.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		if (!(name in parameters)) throw new Error(`Missing template parameter ${name}`);
		return encodeURIComponent(String(parameters[name]));
	});
}

function assertOrigin(value: string, allowedOrigins: string[]): void {
	const url = new URL(value);
	if (!allowedOrigins.includes(url.origin)) throw new Error(`Workflow URL origin ${url.origin} is not allowed`);
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, error: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(error)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function parseRun(value: unknown): BrowserWorkflowRun {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Browser workflow run is invalid");
	const run = value as BrowserWorkflowRun;
	if (
		run.schema !== "pi.browser-workflow-run.v1" ||
		typeof run.id !== "string" ||
		!Array.isArray(run.steps) ||
		!Array.isArray(run.parameterNames)
	) {
		throw new Error("Browser workflow run is invalid");
	}
	return {
		...structuredClone(run),
		steps: run.steps.map((step) => ({
			...step,
			artifacts: Array.isArray(step.artifacts) ? [...step.artifacts] : [],
		})),
	};
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Browser workflow was cancelled");
}

function remainingTime(deadlineAt: number): number {
	const remaining = deadlineAt - Date.now();
	if (remaining < 1) throw new Error("Workflow deadline exceeded");
	return remaining;
}
