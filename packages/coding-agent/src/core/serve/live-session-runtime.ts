import type { ModelRef, SessionPhase, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "@earendil-works/pi-server";

/**
 * The serve host's single boundary to a live Pi session. The concrete
 * AgentSession mapper owns snapshot/progress translation behind this interface.
 */
export interface LiveSessionDelegate {
	snapshot(): SessionSnapshot;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/** Adapts one host-owned live session to PiServer without exposing its internals. */
export class LiveSessionRuntime implements PiSessionRuntime {
	private readonly delegate: LiveSessionDelegate;

	constructor(delegate: LiveSessionDelegate) {
		this.delegate = delegate;
	}

	snapshot(): SessionSnapshot {
		return this.delegate.snapshot();
	}

	getPhase(): SessionPhase {
		return this.delegate.getPhase();
	}

	prompt(input: PromptInput): Promise<void> {
		return this.delegate.prompt(input);
	}

	steer(input: SteerInput): Promise<void> {
		return this.delegate.steer(input);
	}

	abort(): Promise<void> {
		return this.delegate.abort();
	}

	setModel(model: ModelRef): Promise<void> {
		return this.delegate.setModel(model);
	}

	setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		return this.delegate.setThinking(thinkingLevel);
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return this.delegate.subscribe(listener);
	}

	dispose(): Promise<void> {
		return this.delegate.dispose();
	}
}
