import type { AgentRoutineState } from "../agent-routine-scheduler.ts";
import type { RoutineDefinitionInput } from "../routine-registry.ts";
import { createBrowserId } from "./browser-id.ts";

const panels = new Map<string, HTMLDetailsElement>();
const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Reattach the same editor across transcript refreshes, preserving unfinished user input. */
export function teamScheduleControls(roomId: string, token: string): HTMLDetailsElement {
	const existing = panels.get(roomId);
	if (existing) {
		existing.dispatchEvent(new Event("team-schedule-refresh"));
		return existing;
	}
	if (!document.getElementById("team-schedule-theme")) {
		const style = document.createElement("style");
		style.id = "team-schedule-theme";
		style.textContent = `
.team-schedule summary{cursor:pointer;font-weight:600;line-height:1.5}
.team-schedule label{font-size:12px;line-height:1.5;color:var(--muted)}
.team-schedule input:not([type=checkbox]),.team-schedule textarea,.team-schedule select{width:100%;min-width:0;min-height:40px;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);padding:9px 11px;font:inherit}
.team-schedule textarea{min-height:120px;line-height:1.5;resize:vertical}
.team-schedule button{min-height:38px;margin-right:6px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);font:inherit;cursor:pointer;touch-action:manipulation}
.team-schedule button:hover{border-color:var(--pi)}.team-schedule button:disabled{opacity:.45;cursor:default}.team-schedule input[type=checkbox]{accent-color:var(--pi)}
.team-schedule p{line-height:1.5;overflow-wrap:anywhere}.team-schedule input:focus-visible,.team-schedule textarea:focus-visible,.team-schedule select:focus-visible,.team-schedule button:focus-visible{outline:2px solid var(--pi);outline-offset:2px}
`;
		document.head.append(style);
	}
	const panel = document.createElement("details");
	panel.className = "team-schedule";
	panel.dataset.roomId = roomId;
	panel.style.cssText = "margin:18px 0;padding:12px;border:1px solid var(--line);border-radius:12px";
	const summary = document.createElement("summary");
	summary.textContent = "Schedule team";
	const form = document.createElement("form");
	form.style.cssText = "display:grid;gap:12px;padding-top:14px";
	const formHeading = document.createElement("strong");
	formHeading.textContent = "New schedule";
	form.append(formHeading);
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	const list = document.createElement("div");
	const field = (name: string, control: HTMLElement) => {
		control.setAttribute("aria-label", name);
		const label = document.createElement("label");
		label.style.cssText = "display:grid;gap:6px";
		label.append(name, control);
		form.append(label);
		return control;
	};
	const name = field("Schedule name", document.createElement("input")) as HTMLInputElement;
	name.required = true;
	const prompt = field(
		"What should the team accomplish each run?",
		document.createElement("textarea"),
	) as HTMLTextAreaElement;
	prompt.required = true;
	prompt.rows = 4;
	const delivery = field("Delivery", document.createElement("select")) as HTMLSelectElement;
	delivery.add(new Option("Gmail drafts for review", "draft"));
	delivery.add(new Option("Local report only", "report"));
	const timing = field("Repeat", document.createElement("select")) as HTMLSelectElement;
	for (const [value, label] of [
		["weekly", "Weekly"],
		["monthly", "Monthly"],
		["yearly", "Yearly"],
		["daily", "Daily"],
		["weekdays", "Weekdays"],
		["custom", "Custom cron"],
	])
		timing.add(new Option(label, value));
	const day = field("Day", document.createElement("select")) as HTMLSelectElement;
	["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].forEach((label, index) => {
		day.add(new Option(label, String(index)));
	});
	day.value = "1";
	const month = field("Month", document.createElement("select")) as HTMLSelectElement;
	[
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	].forEach((label, index) => {
		month.add(new Option(label, String(index + 1)));
	});
	const date = field("Day of month", document.createElement("select")) as HTMLSelectElement;
	for (let value = 1; value <= 31; value++) date.add(new Option(String(value), String(value)));
	const calendarNote = document.createElement("p");
	calendarNote.className = "muted";
	form.append(calendarNote);
	const time = field("Time", document.createElement("input")) as HTMLInputElement;
	time.type = "time";
	time.value = "09:00";
	time.required = true;
	const timezone = field("Time zone", document.createElement("input")) as HTMLInputElement;
	timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
	timezone.required = true;
	const timezoneNote = document.createElement("p");
	timezoneNote.className = "muted";
	timezoneNote.textContent =
		"Defaults to this device's time zone. Runs use the saved time zone and the Pi server's system clock, including daylight-saving changes. Changing devices does not change a saved schedule's zone. Keep the Pi server running.";
	form.append(timezoneNote);
	const cron = field("Cron", document.createElement("input")) as HTMLInputElement;
	const preview = document.createElement("p");
	preview.className = "muted";
	form.append(preview);
	const confirmed = document.createElement("input");
	confirmed.type = "checkbox";
	const authorization = document.createElement("label");
	authorization.append(
		confirmed,
		" I reviewed a successful run and authorize this saved request with the team's current tools and memory. Gmail delivery creates drafts only; it never authorizes sending.",
	);
	form.append(authorization);
	const actions = document.createElement("div");
	actions.className = "settings-form-actions";
	actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
	const paused = document.createElement("button");
	paused.type = "submit";
	paused.textContent = "Save paused";
	const enable = document.createElement("button");
	enable.type = "submit";
	enable.textContent = "Enable schedule";
	const fresh = document.createElement("button");
	fresh.type = "button";
	fresh.textContent = "New schedule";
	actions.append(paused, enable, fresh);
	form.append(actions);
	panel.append(summary, list, form, status);
	let selected: AgentRoutineState | undefined;
	let loaded = false;
	let reviewedDigest: string | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		const response = await fetch(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		const value: unknown = await response.json();
		if (!response.ok)
			throw new Error(
				typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
					? value.error
					: `Request failed: ${response.status}`,
			);
		return value as T;
	}
	const reportError = (error: unknown) => {
		status.textContent = error instanceof Error ? error.message : String(error);
	};
	async function reviewTools(): Promise<void> {
		confirmed.checked = false;
		reviewedDigest = undefined;
		const review = await request<{ name: string; prompt: string; configurationDigest: string }>(
			`/team-schedules/review?roomId=${encodeURIComponent(roomId)}&delivery=${delivery.value}`,
		);
		reviewedDigest = review.configurationDigest;
		if (!name.value) name.value = `${review.name} schedule`;
		if (!prompt.value) prompt.value = review.prompt;
		status.textContent =
			"Current tools and saved team configuration checked. Review the request and authorization before saving.";
	}
	const recheck = document.createElement("button");
	recheck.type = "button";
	recheck.textContent = "Review current setup";
	recheck.addEventListener("click", () => {
		void reviewTools().catch(reportError);
	});
	actions.append(recheck);
	async function updatePreview(): Promise<void> {
		const [hour, minute] = time.value.split(":").map(Number);
		const calendar = timing.value === "monthly" || timing.value === "yearly";
		const maxDay = timing.value === "yearly" ? daysInMonth[Number(month.value) - 1]! : 31;
		for (const option of date.options) option.disabled = Number(option.value) > maxDay;
		if (Number(date.value) > maxDay) date.value = String(maxDay);
		if (timing.value !== "custom")
			cron.value = `${minute} ${hour} ${calendar ? date.value : "*"} ${timing.value === "yearly" ? month.value : "*"} ${timing.value === "weekly" ? day.value : timing.value === "weekdays" ? "1-5" : "*"}`;
		cron.parentElement!.style.display = timing.value !== "custom" ? "none" : "grid";
		day.parentElement!.style.display = timing.value !== "weekly" ? "none" : "grid";
		month.parentElement!.style.display = timing.value === "yearly" ? "grid" : "none";
		date.parentElement!.style.display = calendar ? "grid" : "none";
		calendarNote.hidden = !calendar;
		calendarNote.textContent =
			timing.value === "monthly"
				? "Months without the selected day are skipped. Choose days 1–28 to run every month."
				: "Runs on this calendar date every year. February is limited to day 28 so the date exists every year.";
		time.parentElement!.style.display = timing.value === "custom" ? "none" : "grid";
		const result = await request<{ next: number[] }>("/routines/preview", "POST", {
			cron: cron.value,
			timezone: timezone.value,
		});
		preview.textContent = `Next runs: ${result.next.map((at) => new Date(at).toLocaleString(undefined, { timeZone: timezone.value })).join(" · ")} (${timezone.value})`;
	}
	async function refresh(): Promise<void> {
		if (refreshTimer) clearTimeout(refreshTimer);
		const result = await request<{ routines: AgentRoutineState[] }>("/routines.json");
		list.replaceChildren();
		for (const routine of result.routines.filter(
			(entry) => entry.target.kind === "team" && entry.target.roomId === roomId,
		)) {
			const row = document.createElement("article");
			row.style.cssText = "padding:12px 0;border-bottom:1px solid var(--line)";
			const description = document.createElement("p");
			description.textContent = `${routine.name} · ${routine.availabilityError ? "Needs review" : routine.activeRunId ? "Running" : routine.enabled ? "Enabled" : "Paused"}${routine.nextRunAt ? ` · Next ${new Date(routine.nextRunAt).toLocaleString()}` : ""}`;
			row.append(description);
			if (routine.lastRunId) {
				const result = document.createElement("p");
				result.textContent = `Last run: ${routine.lastRunId}. Results appear in this team conversation and History.`;
				row.append(result);
			}
			if (routine.lastError || routine.availabilityError) {
				const error = document.createElement("p");
				error.textContent = routine.availabilityError ?? routine.lastError!;
				row.append(error);
			}
			for (const action of ["Edit", "Run once", "Pause"] as const) {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = action;
				button.disabled =
					action === "Run once" &&
					(!!routine.activeRunId ||
						!!routine.availabilityError ||
						routine.target.kind !== "team" ||
						!routine.target.confirmed);
				button.addEventListener("click", () => {
					if (action === "Edit") {
						formHeading.textContent = "Edit schedule";
						selected = routine;
						name.value = routine.name;
						prompt.value = routine.prompt;
						cron.value = routine.cron;
						timezone.value = routine.timezone;
						timing.value = "custom";
						const parts = routine.cron.trim().split(/\s+/);
						if (
							parts.length === 5 &&
							/^\d+$/.test(parts[0]!) &&
							/^\d+$/.test(parts[1]!) &&
							parts[2] === "*" &&
							parts[3] === "*" &&
							/^(?:\*|1-5|[0-6])$/.test(parts[4]!)
						) {
							time.value = `${parts[1]!.padStart(2, "0")}:${parts[0]!.padStart(2, "0")}`;
							timing.value = parts[4] === "*" ? "daily" : parts[4] === "1-5" ? "weekdays" : "weekly";
							if (timing.value === "weekly") day.value = parts[4]!;
						} else if (
							parts.length === 5 &&
							/^\d+$/.test(parts[0]!) &&
							/^\d+$/.test(parts[1]!) &&
							/^(?:[1-9]|[12]\d|3[01])$/.test(parts[2]!) &&
							/^(?:\*|[1-9]|1[0-2])$/.test(parts[3]!) &&
							parts[4] === "*" &&
							(parts[3] === "*" || Number(parts[2]) <= daysInMonth[Number(parts[3]) - 1]!)
						) {
							time.value = `${parts[1]!.padStart(2, "0")}:${parts[0]!.padStart(2, "0")}`;
							timing.value = parts[3] === "*" ? "monthly" : "yearly";
							date.value = parts[2]!;
							if (timing.value === "yearly") month.value = parts[3]!;
						}
						if (routine.target.kind === "team") delivery.value = routine.target.delivery;
						confirmed.checked = false;
						void updatePreview().catch(reportError);
						form.dispatchEvent(new Event("settings-baseline"));
						return;
					}
					button.disabled = true;
					void (async () => {
						if (action === "Pause")
							await request(`/routines/${encodeURIComponent(routine.id)}`, "PUT", {
								...routine,
								enabled: false,
							});
						else {
							const state = await request<AgentRoutineState>(
								`/routines/${encodeURIComponent(routine.id)}/run`,
								"POST",
							);
							if (state.lastError) throw new Error(state.lastError);
							status.textContent = "Started one run. Follow its progress in this team conversation.";
						}
						await refresh();
					})()
						.catch(reportError)
						.finally(() => {
							button.disabled = false;
						});
				});
				row.append(button);
			}
			list.append(row);
		}
		if (
			result.routines.some(
				(entry) => entry.target.kind === "team" && entry.target.roomId === roomId && entry.activeRunId,
			)
		) {
			refreshTimer = setTimeout(() => {
				if (panel.open && panel.isConnected) void refresh().catch(reportError);
			}, 2000);
		}
	}
	fresh.addEventListener("click", () => {
		formHeading.textContent = "New schedule";
		selected = undefined;
		name.value = "";
		confirmed.checked = false;
		status.textContent = "Enter a new schedule name and request.";
		name.focus();
	});
	for (const control of [name, prompt, delivery, timing, day, month, date, time, timezone, cron])
		control.addEventListener("input", () => {
			confirmed.checked = false;
		});
	for (const control of [timing, day, month, date, time, timezone, cron])
		control.addEventListener("change", () => {
			void updatePreview().catch(reportError);
		});
	delivery.addEventListener("change", () => {
		void reviewTools().catch(reportError);
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const enabled = event.submitter === enable;
		if (enabled && !confirmed.checked) {
			status.textContent = "Review and confirm the authorization before enabling this schedule.";
			return;
		}
		paused.disabled = true;
		enable.disabled = true;
		void (async () => {
			const review = await request<{ configurationDigest: string }>(
				`/team-schedules/review?roomId=${encodeURIComponent(roomId)}&delivery=${delivery.value}`,
			);
			if (review.configurationDigest !== reviewedDigest)
				throw new Error("Team setup changed. Select Review current setup, then confirm the schedule again.");
			const definition: RoutineDefinitionInput = {
				id: selected?.id ?? `team-${createBrowserId()}`,
				name: name.value,
				prompt: prompt.value,
				enabled,
				cron: cron.value,
				timezone: timezone.value,
				maxDurationMinutes: 60,
				target: {
					kind: "team",
					roomId,
					configurationDigest: review.configurationDigest,
					delivery: delivery.value === "draft" ? "draft" : "report",
					confirmed: confirmed.checked,
				},
			};
			selected = await request<AgentRoutineState>(
				selected ? `/routines/${encodeURIComponent(selected.id)}` : "/routines",
				selected ? "PUT" : "POST",
				definition,
			);
			formHeading.textContent = "Edit schedule";
			status.textContent = enabled
				? "Schedule enabled. This server must remain running."
				: "Schedule saved paused. It will not run automatically.";
			await refresh();
			form.dispatchEvent(new Event("settings-baseline"));
		})()
			.catch(reportError)
			.finally(() => {
				paused.disabled = false;
				enable.disabled = false;
			});
	});
	panel.addEventListener("toggle", () => {
		if (!panel.open) {
			if (refreshTimer) clearTimeout(refreshTimer);
			return;
		}
		void (async () => {
			await refresh();
			if (!loaded) {
				await reviewTools();
				loaded = true;
				form.dispatchEvent(new Event("settings-baseline"));
			}
			await updatePreview();
		})().catch(reportError);
	});
	panel.addEventListener("team-schedule-refresh", () => {
		if (panel.open) void refresh().catch(reportError);
	});
	panels.set(roomId, panel);
	return panel;
}
