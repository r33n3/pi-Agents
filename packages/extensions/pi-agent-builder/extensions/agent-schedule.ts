import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgentScheduleManifest {
	taskName: string;
	agent: string;
	task: string;
	cadence: string;
	createdAt: string;
	updatedAt?: string;
}

export type AgentScheduleMode = "replace" | "additional";

export interface AgentSchedulePlan {
	taskName: string;
	unchanged: AgentScheduleManifest | undefined;
	replaced: AgentScheduleManifest[];
	createdAt: string | undefined;
}

const DAY_NAMES: Record<string, string> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};

const agentScheduleQueues = new Map<string, Promise<void>>();

async function withAgentScheduleQueue<T>(agentName: string, operation: () => Promise<T>): Promise<T> {
	const preceding = agentScheduleQueues.get(agentName) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = preceding.then(() => current);
	agentScheduleQueues.set(agentName, tail);
	await preceding;
	try {
		return await operation();
	} finally {
		release?.();
		if (agentScheduleQueues.get(agentName) === tail) agentScheduleQueues.delete(agentName);
	}
}

function schedulesDir(): string {
	const dir = join(getAgentDir(), "agents-schedules");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function validManifest(value: unknown): value is AgentScheduleManifest {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<AgentScheduleManifest>;
	return (
		typeof manifest.taskName === "string" &&
		/^pi-agent-[a-z0-9-]+$/.test(manifest.taskName) &&
		typeof manifest.agent === "string" &&
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.agent) &&
		typeof manifest.task === "string" &&
		typeof manifest.cadence === "string" &&
		typeof manifest.createdAt === "string"
	);
}

export function listAgentScheduleManifests(): AgentScheduleManifest[] {
	const manifests: AgentScheduleManifest[] = [];
	for (const entry of readdirSync(schedulesDir())) {
		if (!entry.endsWith(".json")) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(schedulesDir(), entry), "utf-8"));
			if (validManifest(parsed)) manifests.push(parsed);
		} catch {
			// Ignore malformed manifests. They cannot safely identify a scheduled task.
		}
	}
	return manifests;
}

export function schedulesForAgent(agentName: string): AgentScheduleManifest[] {
	return listAgentScheduleManifests().filter((manifest) => manifest.agent === agentName);
}

export function buildAgentScheduleTrigger(cadence: string): string {
	const normalized = cadence.trim().toLowerCase();
	let match = normalized.match(/^daily\s+(\d{1,2}):(\d{2})$/);
	if (match) {
		const hour = Number(match[1]);
		const minute = Number(match[2]);
		if (hour <= 23 && minute <= 59) {
			return `New-ScheduledTaskTrigger -Daily -At "${match[1].padStart(2, "0")}:${match[2]}"`;
		}
	}

	match = normalized.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/);
	if (match) {
		const hour = Number(match[2]);
		const minute = Number(match[3]);
		if (hour <= 23 && minute <= 59) {
			return `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${DAY_NAMES[match[1]]} -At "${match[2].padStart(2, "0")}:${match[3]}"`;
		}
	}

	if (normalized === "hourly") {
		return "New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)";
	}

	match = normalized.match(/^every\s+(\d+)(m|h)$/);
	if (match && Number(match[1]) > 0) {
		const unit = match[2] === "m" ? "Minutes" : "Hours";
		return `New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -${unit} ${match[1]}) -RepetitionDuration ([TimeSpan]::MaxValue)`;
	}

	throw new Error(
		`Unrecognized cadence "${cadence}". Use "daily HH:MM", "weekly <Mon..Sun> HH:MM", "hourly", "every Nm", or "every Nh".`,
	);
}

export function planAgentSchedule(
	existing: readonly AgentScheduleManifest[],
	agentName: string,
	task: string,
	cadence: string,
	mode: AgentScheduleMode,
	additionalTaskName: string,
): AgentSchedulePlan {
	const identical = existing.find((manifest) => manifest.task === task && manifest.cadence === cadence);
	if (mode === "replace" && existing.length === 1 && identical) {
		return {
			taskName: identical.taskName,
			unchanged: identical,
			replaced: [],
			createdAt: identical.createdAt,
		};
	}

	const newest = [...existing].sort((left, right) => {
		const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
		const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
		return rightTime - leftTime;
	})[0];
	const taskName =
		mode === "additional" ? additionalTaskName : (newest?.taskName ?? `pi-agent-${agentName}`);
	return {
		taskName,
		unchanged: undefined,
		replaced: mode === "replace" ? existing.filter((manifest) => manifest.taskName !== taskName) : [],
		createdAt: mode === "replace" ? newest?.createdAt : undefined,
	};
}

function runPowerShell(script: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const process = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		process.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});
		process.stderr.on("data", (data: Buffer) => {
			output += data.toString();
		});
		process.on("close", (code) => resolve({ ok: code === 0, output }));
		process.on("error", (error) => resolve({ ok: false, output: error.message }));
	});
}

function writeManifest(manifest: AgentScheduleManifest): void {
	const target = join(schedulesDir(), `${manifest.taskName}.json`);
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(manifest, null, 2), "utf-8");
	renameSync(temporary, target);
}

export async function removeAgentSchedule(manifest: AgentScheduleManifest): Promise<void> {
	const result = await runPowerShell(
		`Unregister-ScheduledTask -TaskName "${manifest.taskName}" -Confirm:$false -ErrorAction SilentlyContinue`,
	);
	if (!result.ok) throw new Error(`Failed to remove scheduled task "${manifest.taskName}": ${result.output.trim()}`);
	const path = join(schedulesDir(), `${manifest.taskName}.json`);
	if (existsSync(path)) unlinkSync(path);
}

export async function scheduleAgent(
	agentName: string,
	task: string,
	cadence: string,
	mode: AgentScheduleMode = "replace",
): Promise<{ manifest: AgentScheduleManifest; replaced: number; unchanged: boolean }> {
	return withAgentScheduleQueue(agentName, () => scheduleAgentUnlocked(agentName, task, cadence, mode));
}

async function scheduleAgentUnlocked(
	agentName: string,
	task: string,
	cadence: string,
	mode: AgentScheduleMode,
): Promise<{ manifest: AgentScheduleManifest; replaced: number; unchanged: boolean }> {
	const trigger = buildAgentScheduleTrigger(cadence);
	const existing = schedulesForAgent(agentName);
	const plan = planAgentSchedule(
		existing,
		agentName,
		task,
		cadence,
		mode,
		`pi-agent-${agentName}-${randomBytes(3).toString("hex")}`,
	);
	if (plan.unchanged) return { manifest: plan.unchanged, replaced: 0, unchanged: true };
	const taskName = plan.taskName;
	const runAgentScript = join(getAgentDir(), "bin", "run-agent.mjs");
	const script = [
		`$action = New-ScheduledTaskAction -Execute '${process.execPath.replaceAll("'", "''")}' -Argument '"${runAgentScript.replaceAll("'", "''")}" --schedule ${taskName}'`,
		`$trigger = ${trigger}`,
		`Register-ScheduledTask -TaskName "${taskName}" -Action $action -Trigger $trigger -Description "pi agent: ${agentName}" -Force | Out-Null`,
	].join("\n");
	const result = await runPowerShell(script);
	if (!result.ok) throw new Error(`Failed to register scheduled task: ${result.output.trim()}`);

	const now = new Date().toISOString();
	const manifest: AgentScheduleManifest = {
		taskName,
		agent: agentName,
		task,
		cadence,
		createdAt: plan.createdAt ?? now,
		updatedAt: now,
	};
	writeManifest(manifest);

	if (mode === "replace") {
		for (const stale of plan.replaced) await removeAgentSchedule(stale);
	}
	return {
		manifest,
		replaced: plan.replaced.length,
		unchanged: false,
	};
}
