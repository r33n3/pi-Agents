import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import type { AgentTask, AgentTaskEvent, AgentTaskService } from "./agent-task-service.ts";

export const A2A_SPECIFICATION_RELEASE = "1.0.1";
export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_MEDIA_TYPE = "application/a2a+json";

export interface A2aAgentCard {
	name: string;
	description: string;
	version: string;
	supportedInterfaces: Array<{
		url: string;
		protocolBinding: "HTTP+JSON";
		protocolVersion: "1.0";
	}>;
	capabilities: { streaming: true };
	securitySchemes: { bearer: { type: "http"; scheme: "bearer" } };
	securityRequirements: Array<{ bearer: string[] }>;
	defaultInputModes: ["text/plain"];
	defaultOutputModes: ["text/plain", "application/json"];
	skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
	iconUrl?: string;
}

/** Maps the public A2A v1.0 HTTP+JSON task model to the internal task service. */
export class A2aAdapter {
	readonly #registry: AgentRegistry;
	readonly #tasks: AgentTaskService;

	constructor(registry: AgentRegistry, tasks: AgentTaskService) {
		this.#registry = registry;
		this.#tasks = tasks;
	}

	validateVersion(value: string | undefined): void {
		if (value !== A2A_PROTOCOL_VERSION)
			throw new A2aError("VERSION_NOT_SUPPORTED", 400, `A2A version ${value ?? "<missing>"} is not supported`);
	}

	async agentCard(agentId: string, baseUrl: string): Promise<A2aAgentCard> {
		const agent = await this.#exposedAgent(agentId);
		return {
			name: agent.name,
			description: agent.description,
			version: String(agent.revision),
			supportedInterfaces: [
				{
					url: `${baseUrl.replace(/\/$/, "")}/a2a/agents/${encodeURIComponent(agent.id)}`,
					protocolBinding: "HTTP+JSON",
					protocolVersion: A2A_PROTOCOL_VERSION,
				},
			],
			capabilities: { streaming: true },
			securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
			securityRequirements: [{ bearer: [] }],
			defaultInputModes: ["text/plain"],
			defaultOutputModes: ["text/plain", "application/json"],
			skills: [{ id: agent.id, name: agent.name, description: agent.description, tags: ["pi-agent"] }],
			iconUrl: `/agents/${encodeURIComponent(agent.id)}/icon`,
		};
	}

	async sendMessage(agentId: string, value: unknown): Promise<{ task: A2aTask }> {
		await this.#exposedAgent(agentId);
		const input = object(value, "SendMessageRequest");
		const message = object(input.message, "message");
		const prompt = messageText(message.parts);
		const taskId = optionalString(message.taskId);
		const task = taskId
			? await this.#tasks.continue(taskId, prompt)
			: await this.#tasks.submit({
					agentId,
					source: "a2a",
					prompt,
				});
		return { task: toA2aTask(task) };
	}

	getTask(agentId: string, taskId: string): A2aTask {
		const task = this.#tasks.getTask(taskId);
		if (!task || task.agentId !== agentId) throw new A2aError("TASK_NOT_FOUND", 404, "Task was not found");
		return toA2aTask(task);
	}

	listTasks(agentId: string, status?: string): { tasks: A2aTask[]; totalSize: number; pageSize: number } {
		const tasks = this.#tasks
			.listTasks({ agentId })
			.map(toA2aTask)
			.filter((task) => status === undefined || task.status.state === status);
		return { tasks, totalSize: tasks.length, pageSize: tasks.length };
	}

	async cancelTask(agentId: string, taskId: string): Promise<A2aTask> {
		this.getTask(agentId, taskId);
		try {
			return toA2aTask(await this.#tasks.cancel(taskId));
		} catch (error) {
			throw new A2aError(
				"TASK_NOT_CANCELABLE",
				400,
				error instanceof Error ? error.message : "Task cannot be cancelled",
			);
		}
	}

	subscribe(agentId: string, taskId: string, listener: (task: A2aTask) => void): () => void {
		const task = this.#tasks.getTask(taskId);
		if (!task || task.agentId !== agentId) throw new A2aError("TASK_NOT_FOUND", 404, "Task was not found");
		if (isTerminal(task.status))
			throw new A2aError("UNSUPPORTED_OPERATION", 400, "Terminal tasks cannot be subscribed to");
		return this.#tasks.subscribe((event: AgentTaskEvent) => {
			if (event.taskId !== taskId) return;
			const current = this.#tasks.getTask(taskId);
			if (current) listener(toA2aTask(current));
		});
	}

	async #exposedAgent(agentId: string): Promise<AgentDefinition> {
		const agent = await this.#registry.get(agentId);
		if (!agent?.a2a.enabled) throw new A2aError("AGENT_NOT_FOUND", 404, "Agent was not found");
		return agent;
	}
}

export interface A2aTask {
	id: string;
	contextId: string;
	status: {
		state:
			| "TASK_STATE_SUBMITTED"
			| "TASK_STATE_WORKING"
			| "TASK_STATE_COMPLETED"
			| "TASK_STATE_FAILED"
			| "TASK_STATE_CANCELED";
		timestamp: string;
		message?: { role: "ROLE_AGENT"; parts: Array<{ text: string }> };
	};
	artifacts?: Array<{ artifactId: string; name: string; parts: Array<{ text: string }> }>;
}

export class A2aError extends Error {
	readonly reason: string;
	readonly status: number;

	constructor(reason: string, status: number, message: string) {
		super(message);
		this.reason = reason;
		this.status = status;
	}
}

function toA2aTask(task: AgentTask): A2aTask {
	const timestamp = new Date(task.finishedAt ?? task.startedAt ?? task.createdAt).toISOString();
	return {
		id: task.id,
		contextId: task.conversationId,
		status: {
			state:
				task.status === "queued"
					? "TASK_STATE_SUBMITTED"
					: task.status === "running"
						? "TASK_STATE_WORKING"
						: task.status === "completed"
							? "TASK_STATE_COMPLETED"
							: task.status === "cancelled"
								? "TASK_STATE_CANCELED"
								: "TASK_STATE_FAILED",
			timestamp,
			message: task.error ? { role: "ROLE_AGENT", parts: [{ text: task.error }] } : undefined,
		},
		artifacts:
			task.result === undefined
				? undefined
				: [{ artifactId: `${task.id}-result`, name: "result", parts: [{ text: task.result }] }],
	};
}

function messageText(value: unknown): string {
	if (!Array.isArray(value)) throw new A2aError("INVALID_PARAMS", 400, "message.parts must be an array");
	const text = value
		.map((entry) =>
			typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string"
				? entry.text
				: "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
	if (!text) throw new A2aError("INVALID_PARAMS", 400, "At least one text part is required");
	return text;
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new A2aError("INVALID_PARAMS", 400, `${name} must be an object`);
	return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTerminal(status: AgentTask["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
