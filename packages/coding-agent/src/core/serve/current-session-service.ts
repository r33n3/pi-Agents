import { readFile } from "node:fs/promises";
import { type ImageContent, ModelControlsError } from "@earendil-works/pi-ai";
import type { ModelMetadata, SessionMetadata } from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiServerService,
	type PiSessionRuntime,
	toProtocolModelMetadata,
} from "@earendil-works/pi-server";
import type { AgentSession } from "../agent-session.ts";
import { AgentSessionServeDelegate, runSupervisedSessionPrompt } from "./agent-session-serve-delegate.ts";
import { LiveSessionRuntime } from "./live-session-runtime.ts";
import type { ServeAttachment } from "./serve-attachment-store.ts";

export type HostedSessionFactory = (options: CreateSessionOptions) => Promise<AgentSession>;

interface HostedSession {
	session: AgentSession;
	createdAt: number;
	runtime: PiSessionRuntime;
}

/** Exposes the host session plus optional isolated browser-owned helper sessions. */
export class CurrentSessionService implements PiServerService {
	readonly #session: AgentSession;
	readonly #createdAt: number;
	readonly #runtime: PiSessionRuntime;
	readonly #createHostedSession: HostedSessionFactory | undefined;
	readonly #hosted = new Map<string, HostedSession>();

	constructor(session: AgentSession, createdAt = Date.now(), createHostedSession?: HostedSessionFactory) {
		this.#session = session;
		this.#createdAt = createdAt;
		this.#createHostedSession = createHostedSession;
		this.#runtime = new LiveSessionRuntime(new AgentSessionServeDelegate(session, createdAt));
	}

	async listSessions(): Promise<SessionMetadata[]> {
		return [
			this.#metadata(this.#session, this.#createdAt),
			...[...this.#hosted.values()].map((entry) => this.#metadata(entry.session, entry.createdAt)),
		];
	}

	async listModels(): Promise<ModelMetadata[]> {
		return this.#session.modelRuntime.getAvailableSnapshot().map((model) => ({
			...toProtocolModelMetadata(model, true),
			controls: this.#session.modelRuntime.getModelControlCapabilities(model),
			catalogRefresh: this.#session.modelRuntime.getCatalogRefreshStatus(model.provider),
			catalog: this.#session.modelRuntime.getModelProvenance(model.provider, model.id),
		}));
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		if (options.modelControls != null && options.thinkingLevel !== undefined)
			throw new PiServerError("invalid_request", "Choose native model controls or legacy thinkingLevel, not both");
		if (!this.#createHostedSession)
			throw new PiServerError("not_implemented", "Browser helper sessions are disabled");
		if (this.#hosted.has(options.id) || options.id === this.#session.sessionId) {
			throw new PiServerError("session_locked", `Session already exists: ${options.id}`);
		}
		let session: AgentSession | undefined;
		try {
			session = await this.#createHostedSession(options);
			if (session.sessionId !== options.id) {
				throw new Error(`Hosted session factory returned ${session.sessionId}, expected ${options.id}`);
			}
			const controls = session.modelControls;
			if (controls !== undefined) {
				if (!session.model) throw new PiServerError("invalid_request", "No model is selected");
				session.modelRuntime.validateModelControls(session.model, controls);
			}
		} catch (error) {
			session?.dispose();
			if (error instanceof ModelControlsError) throw new PiServerError("invalid_request", error.message);
			throw error;
		}
		const createdAt = Date.now();
		const hostedSession = session;
		let disposed = false;
		const runtime = new LiveSessionRuntime(
			new AgentSessionServeDelegate(session, createdAt, () => {
				if (disposed) return;
				disposed = true;
				this.#hosted.delete(options.id);
				hostedSession.dispose();
			}),
		);
		this.#hosted.set(options.id, { session, createdAt, runtime });
		return runtime;
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		if (sessionId === this.#session.sessionId) return this.#runtime;
		const hosted = this.#hosted.get(sessionId);
		if (hosted) return hosted.runtime;
		throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
	}

	async promptWithAttachments(sessionId: string, text: string, attachments: ServeAttachment[]): Promise<void> {
		const session = this.#findSession(sessionId);
		const images: ImageContent[] = [];
		const context: string[] = [];
		for (const attachment of attachments) {
			if (isModelImage(attachment.mimeType)) {
				images.push({
					type: "image",
					data: (await readFile(attachment.path)).toString("base64"),
					mimeType: attachment.mimeType,
				});
				continue;
			}
			if (isInlineText(attachment) && attachment.size <= 1024 * 1024) {
				context.push(
					`Attached file: ${attachment.name}\n--- attachment content ---\n${await readFile(attachment.path, "utf8")}\n--- end attachment ---`,
				);
				continue;
			}
			context.push(`Attached file: ${attachment.name}\nLocal path: ${attachment.path}`);
		}
		const prompt = context.length > 0 ? `${text}\n\n${context.join("\n\n")}` : text;
		await runSupervisedSessionPrompt(session, () => session.prompt(prompt, { images }));
	}

	#findSession(sessionId: string): AgentSession {
		if (sessionId === this.#session.sessionId) return this.#session;
		const hosted = this.#hosted.get(sessionId);
		if (hosted) return hosted.session;
		throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
	}

	#metadata(session: AgentSession, createdAt: number): SessionMetadata {
		return {
			id: session.sessionId,
			createdAt,
			updatedAt: Date.now(),
			sessionName: session.sessionName,
			cwd: session.sessionManager.getCwd(),
		};
	}
}

function isModelImage(mimeType: string): boolean {
	return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType);
}

function isInlineText(attachment: ServeAttachment): boolean {
	return (
		attachment.mimeType.startsWith("text/") ||
		["application/json", "application/xml", "application/javascript"].includes(attachment.mimeType)
	);
}
