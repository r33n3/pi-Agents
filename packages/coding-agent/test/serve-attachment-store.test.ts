import { describe, expect, test } from "vitest";
import { MAX_SERVE_ATTACHMENT_BYTES, ServeAttachmentStore } from "../src/core/serve/serve-attachment-store.ts";

describe("ServeAttachmentStore", () => {
	test("stores, renames, reads, and removes session-scoped attachments", async () => {
		const store = new ServeAttachmentStore();
		try {
			const saved = await store.save({
				sessionId: "session-1",
				name: "notes.txt",
				mimeType: "text/plain",
				data: Buffer.from("hello").toString("base64"),
			});
			expect(saved).toMatchObject({ sessionId: "session-1", name: "notes.txt", size: 5 });
			expect(await store.read(saved.id)).toEqual(Buffer.from("hello"));
			expect(store.getForSession("session-1", [saved.id])).toHaveLength(1);
			expect(() => store.getForSession("session-2", [saved.id])).toThrow("Unknown attachment");
			expect(await store.rename(saved.id, "renamed.md")).toMatchObject({ name: "renamed.md" });
			expect(await store.delete(saved.id)).toBe(true);
			expect(store.get(saved.id)).toBeUndefined();
		} finally {
			await store.dispose();
		}
	});

	test("rejects unsafe names, invalid base64, and oversized files", async () => {
		const store = new ServeAttachmentStore();
		try {
			await expect(
				store.save({ sessionId: "session", name: "../secret", data: Buffer.from("x").toString("base64") }),
			).rejects.toThrow("name is invalid");
			await expect(store.save({ sessionId: "session", name: "notes.txt", data: "not-base64" })).rejects.toThrow(
				"valid base64",
			);
			await expect(
				store.save({
					sessionId: "session",
					name: "large.bin",
					data: Buffer.alloc(MAX_SERVE_ATTACHMENT_BYTES + 1).toString("base64"),
				}),
			).rejects.toThrow("10 MiB");
		} finally {
			await store.dispose();
		}
	});
});
