export interface InlineThinkingSegment {
	type: "text" | "thinking";
	text: string;
}

export function splitInlineThinking(text: string): InlineThinkingSegment[] {
	const segments: InlineThinkingSegment[] = [];
	const block = /<(thinking|think)>([\s\S]*?)<\/\1>/gi;
	let cursor = 0;
	for (const match of text.matchAll(block)) {
		const index = match.index;
		if (index > cursor) segments.push({ type: "text", text: text.slice(cursor, index) });
		if (match[2]?.trim()) segments.push({ type: "thinking", text: match[2].trim() });
		cursor = index + match[0].length;
	}
	const remainder = text.slice(cursor);
	const open = /<(?:thinking|think)>/i.exec(remainder);
	if (open?.index !== undefined) {
		if (open.index > 0) segments.push({ type: "text", text: remainder.slice(0, open.index) });
		const thinkingText = remainder.slice(open.index + open[0].length).trim();
		if (thinkingText) segments.push({ type: "thinking", text: thinkingText });
	} else if (remainder) segments.push({ type: "text", text: remainder });
	return segments.length > 0 ? segments : [{ type: "text", text }];
}
