import type { BrowserArtifactStore } from "./browser-artifact-store.ts";
import type { BrowserProfileStatus, BrowserProfileStore } from "./browser-profile-store.ts";
import type {
	BrowserDiagnostics,
	BrowserFrame,
	BrowserOwner,
	BrowserSessionManager,
	BrowserSessionSnapshot,
	BrowserWorkspace,
} from "./browser-session-manager.ts";
import type { BrowserWorkflowCapture, BrowserWorkflowCaptureStore } from "./browser-workflow-capture.ts";
import type { BrowserWorkflowCompiler } from "./browser-workflow-compiler.ts";
import type { BrowserFrontendTest, BrowserWorkflowReferenceStore } from "./browser-workflow-reference-store.ts";
import type { BrowserWorkflowDefinition, BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import type { BrowserWorkflowRun, BrowserWorkflowRunner } from "./browser-workflow-runner.ts";
import type { BrowserInstallationStatus } from "./playwright-browser-driver.ts";

export interface BrowserConsoleStatus extends BrowserInstallationStatus {
	browser: "chromium";
	sessionCount: number;
}

/** Exposes the safe, token-gated browser console view without leaking driver objects. */
export class BrowserConsoleService {
	readonly #manager: BrowserSessionManager;
	readonly #installationStatus: () => BrowserInstallationStatus;
	readonly #workflowCompiler: BrowserWorkflowCompiler | undefined;
	readonly #workflowRegistry: BrowserWorkflowRegistry | undefined;
	readonly #workflowRunner: BrowserWorkflowRunner | undefined;
	readonly #defaultRunContext: { owner: BrowserOwner; workspace: BrowserWorkspace } | undefined;
	readonly #captureStore: BrowserWorkflowCaptureStore | undefined;
	readonly #profileStore: BrowserProfileStore | undefined;
	readonly #referenceStore: BrowserWorkflowReferenceStore | undefined;
	readonly #artifactStore: BrowserArtifactStore | undefined;

	constructor(
		manager: BrowserSessionManager,
		installationStatus: () => BrowserInstallationStatus,
		workflowCompiler?: BrowserWorkflowCompiler,
		workflowRegistry?: BrowserWorkflowRegistry,
		workflowRunner?: BrowserWorkflowRunner,
		defaultRunContext?: { owner: BrowserOwner; workspace: BrowserWorkspace },
		captureStore?: BrowserWorkflowCaptureStore,
		profileStore?: BrowserProfileStore,
		referenceStore?: BrowserWorkflowReferenceStore,
		artifactStore?: BrowserArtifactStore,
	) {
		this.#manager = manager;
		this.#installationStatus = installationStatus;
		this.#workflowCompiler = workflowCompiler;
		this.#workflowRegistry = workflowRegistry;
		this.#workflowRunner = workflowRunner;
		this.#defaultRunContext = defaultRunContext;
		this.#captureStore = captureStore;
		this.#profileStore = profileStore;
		this.#referenceStore = referenceStore;
		this.#artifactStore = artifactStore;
	}

	status(): BrowserConsoleStatus {
		const status = this.#installationStatus();
		return {
			browser: "chromium",
			...status,
			installedChrome: status.installedChrome ?? false,
			sessionCount: this.#manager.list().filter((session) => session.status !== "closed").length,
		};
	}

	list(owner?: BrowserOwner): BrowserSessionSnapshot[] {
		return this.#manager.list(owner);
	}

	listProfiles(): Promise<BrowserProfileStatus[]> {
		if (!this.#profileStore) throw new Error("Browser profile store is unavailable");
		return this.#profileStore.list();
	}

	async clearProfile(id: string): Promise<boolean> {
		if (!this.#profileStore) throw new Error("Browser profile store is unavailable");
		if (
			this.#manager
				.list()
				.some(
					(session) =>
						session.status !== "closed" && session.profile.kind === "named" && session.profile.id === id,
				)
		) {
			throw new Error(`Browser profile ${id} is currently in use`);
		}
		return this.#profileStore.clear(id);
	}

	get(id: string): BrowserSessionSnapshot | undefined {
		return this.#manager.get(id);
	}

	screenshot(id: string): Promise<Uint8Array> {
		return this.#manager.screenshot(id);
	}

	subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
		return this.#manager.subscribeFrames(id, listener);
	}

	diagnostics(id: string): BrowserDiagnostics {
		return this.#manager.diagnostics(id);
	}

	navigate(id: string, url: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.navigate(id, url, "user");
	}

	goBack(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.goBack(id, "user");
	}

	goForward(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.goForward(id, "user");
	}

	reload(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.reload(id, "user");
	}

	setControl(id: string, controlOwner: "agent" | "user"): Promise<BrowserSessionSnapshot> {
		return this.#manager.setControl(id, controlOwner);
	}

	pointerClick(id: string, x: number, y: number): Promise<void> {
		return this.#manager.pointerClick(id, x, y);
	}

	typeText(id: string, text: string): Promise<void> {
		return this.#manager.typeText(id, text);
	}

	scroll(id: string, deltaX: number, deltaY: number): Promise<void> {
		return this.#manager.scroll(id, deltaX, deltaY);
	}

	startCapture(id: string): Promise<BrowserWorkflowCapture> {
		return this.#manager.startCapture(id);
	}

	async stopCapture(id: string): Promise<{ capture: BrowserWorkflowCapture; workflow?: BrowserWorkflowDefinition }> {
		const capture = await this.#manager.stopCapture(id);
		return { capture, workflow: await this.#workflowCompiler?.compile(capture) };
	}

	getCapture(id: string): BrowserWorkflowCapture | undefined {
		return this.#manager.getCapture(id);
	}

	listWorkflows(): BrowserWorkflowDefinition[] {
		return this.#workflowRegistry?.list() ?? [];
	}

	getWorkflow(id: string, version?: number): BrowserWorkflowDefinition | undefined {
		return this.#workflowRegistry?.get(id, version);
	}

	validateWorkflow(
		id: string,
		version: number,
		parameters: Record<string, string | number | boolean>,
	): Promise<BrowserWorkflowRun> {
		const context = this.#requireWorkflowRuntime();
		return context.runner.validate(id, version, { ...context.input, parameters });
	}

	activateWorkflow(id: string, version: number): Promise<BrowserWorkflowDefinition> {
		if (!this.#workflowRegistry) throw new Error("Browser workflow registry is unavailable");
		return this.#workflowRegistry.activate(id, version);
	}

	deleteWorkflow(id: string): Promise<boolean> {
		if (!this.#workflowRegistry) throw new Error("Browser workflow registry is unavailable");
		return this.#workflowRegistry.delete(id);
	}

	executeWorkflow(
		id: string,
		version: number,
		parameters: Record<string, string | number | boolean>,
		approved = false,
	): Promise<BrowserWorkflowRun> {
		const context = this.#requireWorkflowRuntime();
		return context.runner.executeVersion(id, version, { ...context.input, parameters, approved });
	}

	listWorkflowRuns(workflowId?: string): BrowserWorkflowRun[] {
		return this.#workflowRunner?.list(workflowId) ?? [];
	}

	async readWorkflowArtifact(runId: string, artifactId: string): Promise<Uint8Array | undefined> {
		if (!this.#workflowRunner || !this.#artifactStore) throw new Error("Browser workflow artifacts are unavailable");
		const run = this.#workflowRunner.get(runId);
		if (!run) return undefined;
		if (!run.steps.some((step) => step.artifacts.some((artifact) => artifact.id === artifactId))) return undefined;
		return this.#artifactStore.read(run.owner, artifactId);
	}

	createWorkflowSkill(id: string, version: number): Promise<{ name: string; path: string }> {
		if (!this.#referenceStore) throw new Error("Browser workflow references are unavailable");
		return this.#referenceStore.createSkill({ workflowId: id, workflowVersion: version });
	}

	attachFrontendTest(id: string, version: number): Promise<BrowserFrontendTest> {
		const context = this.#requireWorkflowRuntime();
		if (!this.#referenceStore) throw new Error("Browser workflow references are unavailable");
		return this.#referenceStore.attachFrontendTest(context.input.workspace.root, {
			workflowId: id,
			workflowVersion: version,
		});
	}

	listFrontendTests(): BrowserFrontendTest[] {
		const context = this.#requireWorkflowRuntime();
		return this.#referenceStore?.listFrontendTests(context.input.workspace.root) ?? [];
	}

	workflowReview(
		id: string,
		version?: number,
	): {
		workflow: BrowserWorkflowDefinition;
		issues: Array<{
			stepId: string;
			code: string;
			message: string;
			candidates: Array<{ index: number; role: string; name: string; label?: string; testId?: string; id?: string }>;
		}>;
	} {
		const workflow = this.#workflowRegistry?.get(id, version);
		if (!workflow) throw new Error("Browser workflow was not found");
		const capture = workflow.source.captureId ? this.#captureStore?.get(workflow.source.captureId) : undefined;
		return {
			workflow,
			issues: workflow.compileIssues.map((issue) => {
				const step = capture?.steps.find((entry) => normalizeStepId(entry.id) === issue.stepId);
				return {
					...issue,
					candidates: (step?.before.elements ?? []).map((element, index) => ({
						index,
						role: element.role,
						name: element.name,
						label: element.label,
						testId: element.testId,
						id: element.id,
					})),
				};
			}),
		};
	}

	async resolveWorkflowTarget(
		id: string,
		version: number,
		stepId: string,
		elementIndex: number,
	): Promise<BrowserWorkflowDefinition> {
		if (!this.#workflowCompiler || !this.#captureStore || !this.#workflowRegistry) {
			throw new Error("Browser workflow compiler is unavailable");
		}
		const workflow = this.#workflowRegistry.get(id, version);
		if (!workflow?.source.captureId) throw new Error("Recorded browser workflow was not found");
		const capture = this.#captureStore.get(workflow.source.captureId);
		if (!capture) throw new Error("Browser capture evidence was not found");
		const capturedStep = capture.steps.find((entry) => normalizeStepId(entry.id) === stepId);
		const element = capturedStep?.before.elements[elementIndex];
		if (!capturedStep || !element) throw new Error("Recorded browser target candidate was not found");
		const targetOverrides = Object.fromEntries(
			workflow.steps.flatMap((step) => {
				if (!("target" in step) || !step.target) return [];
				const captured = capture.steps.find((entry) => normalizeStepId(entry.id) === step.id);
				const resolved =
					captured && "target" in captured.action && captured.action.target
						? captured.action.target
						: browserElementFromTarget(step.target);
				return resolved && captured ? [[captured.id, resolved] as const] : [];
			}),
		);
		targetOverrides[capturedStep.id] = element;
		return this.#workflowCompiler.compile(capture, {
			id: workflow.id,
			name: workflow.name,
			description: workflow.description,
			targetOverrides,
		});
	}

	#requireWorkflowRuntime(): {
		runner: BrowserWorkflowRunner;
		input: { owner: BrowserOwner; workspace: BrowserWorkspace };
	} {
		if (!this.#workflowRunner || !this.#defaultRunContext) {
			throw new Error("Browser workflow runner is unavailable");
		}
		return { runner: this.#workflowRunner, input: this.#defaultRunContext };
	}
}

function browserElementFromTarget(target: {
	candidates: Array<
		| { kind: "role"; role: string; name: string }
		| { kind: "label" | "text"; text: string }
		| { kind: "test-id" | "id"; value: string }
	>;
	expected: { tag?: string; role?: string; inputType?: string };
}): { role: string; name: string; tag?: string; label?: string; testId?: string; id?: string; inputType?: string } {
	const role = target.candidates.find((candidate) => candidate.kind === "role");
	const label = target.candidates.find((candidate) => candidate.kind === "label");
	const testId = target.candidates.find((candidate) => candidate.kind === "test-id");
	const id = target.candidates.find((candidate) => candidate.kind === "id");
	const text = target.candidates.find((candidate) => candidate.kind === "text");
	return {
		role: role?.kind === "role" ? role.role : (target.expected.role ?? target.expected.tag ?? "element"),
		name:
			role?.kind === "role"
				? role.name
				: label?.kind === "label"
					? label.text
					: text?.kind === "text"
						? text.text
						: "",
		tag: target.expected.tag,
		label: label?.kind === "label" ? label.text : undefined,
		testId: testId?.kind === "test-id" ? testId.value : undefined,
		id: id?.kind === "id" ? id.value : undefined,
		inputType: target.expected.inputType,
	};
}

function normalizeStepId(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "recorded-step"
	);
}
