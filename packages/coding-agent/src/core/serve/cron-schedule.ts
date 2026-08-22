const FIELD_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
] as const;

interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
}

/** Parses a standard five-field cron expression and returns its next matching minute. */
export function nextCronRun(cron: string, timezone: string, after = Date.now()): number {
	const parsed = parseCron(cron);
	const formatter = createFormatter(timezone);
	let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
	const limit = candidate + 366 * 24 * 60 * 60_000;
	for (; candidate <= limit; candidate += 60_000) {
		const values = localParts(formatter, candidate);
		if (
			parsed.minutes.has(values.minute) &&
			parsed.hours.has(values.hour) &&
			parsed.days.has(values.day) &&
			parsed.months.has(values.month) &&
			parsed.weekdays.has(values.weekday)
		) {
			return candidate;
		}
	}
	throw new Error("Cron expression has no matching time in the next 366 days");
}

export function validateCron(cron: string, timezone: string): void {
	parseCron(cron);
	createFormatter(timezone);
}

function parseCron(cron: string): ParsedCron {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("cron must contain five fields: minute hour day month weekday");
	return {
		minutes: parseField(fields[0]!, ...FIELD_RANGES[0]),
		hours: parseField(fields[1]!, ...FIELD_RANGES[1]),
		days: parseField(fields[2]!, ...FIELD_RANGES[2]),
		months: parseField(fields[3]!, ...FIELD_RANGES[3]),
		weekdays: normalizeWeekdays(parseField(fields[4]!, ...FIELD_RANGES[4])),
	};
}

function parseField(field: string, minimum: number, maximum: number): Set<number> {
	const values = new Set<number>();
	for (const segment of field.split(",")) {
		const [rangeText, stepText] = segment.split("/");
		if (segment.split("/").length > 2) throw new Error(`Invalid cron field: ${field}`);
		const step = stepText === undefined ? 1 : parseInteger(stepText, 1, maximum - minimum + 1, "cron step");
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = minimum;
			end = maximum;
		} else if (rangeText?.includes("-")) {
			const bounds = rangeText.split("-");
			if (bounds.length !== 2) throw new Error(`Invalid cron range: ${rangeText}`);
			start = parseInteger(bounds[0]!, minimum, maximum, "cron range start");
			end = parseInteger(bounds[1]!, minimum, maximum, "cron range end");
			if (start > end) throw new Error(`Cron range start must not exceed end: ${rangeText}`);
		} else {
			start = parseInteger(rangeText ?? "", minimum, maximum, "cron value");
			end = start;
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	if (values.size === 0) throw new Error(`Cron field is empty: ${field}`);
	return values;
}

function normalizeWeekdays(values: Set<number>): Set<number> {
	if (values.has(7)) {
		values.delete(7);
		values.add(0);
	}
	return values;
}

function parseInteger(value: string, minimum: number, maximum: number, name: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	return parsed;
}

function createFormatter(timezone: string): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			minute: "numeric",
			hour: "numeric",
			day: "numeric",
			month: "numeric",
			weekday: "short",
			hourCycle: "h23",
		});
	} catch {
		throw new Error(`Unsupported timezone: ${timezone}`);
	}
}

function localParts(
	formatter: Intl.DateTimeFormat,
	timestamp: number,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
	const parts = new Map(formatter.formatToParts(timestamp).map((entry) => [entry.type, entry.value]));
	const weekday = parts.get("weekday");
	const weekdayIndex = weekday ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday) : -1;
	if (weekdayIndex < 0) throw new Error("Could not calculate cron weekday");
	return {
		minute: Number(parts.get("minute")),
		hour: Number(parts.get("hour")),
		day: Number(parts.get("day")),
		month: Number(parts.get("month")),
		weekday: weekdayIndex,
	};
}
