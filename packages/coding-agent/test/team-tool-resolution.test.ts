import { expect, test } from "vitest";
import { TeamResources, type TeamToolOption } from "../src/core/serve/team-resources.ts";

class Resources extends TeamResources {
	options: TeamToolOption[] = [
		{
			id: "serpapi-flights:flights.search",
			name: "Research flight fares",
			description: "",
			tools: ["flight_search"],
			capabilities: [],
		},
		{
			id: "aviationstack:flights.status",
			name: "Flight status and arrivals",
			description: "",
			tools: ["flight_status"],
			capabilities: [],
		},
		{
			id: "data_tools",
			name: "Create reusable data tools",
			description: "",
			tools: ["data_tools"],
			capabilities: [],
		},
	];
	override list() {
		return [...super.list(), ...this.options];
	}
}
test("resolves the exact Flight Finder proposal labels and runtime names to stable IDs", () => {
	const resources = new Resources();
	expect(
		["Research flight fares", "Flight status and arrivals", "Create reusable data tools"].map(
			(name) => resources.resolveTool(name).id,
		),
	).toEqual(resources.options.map((entry) => entry.id));
	expect(resources.resolveTool("  RESEARCH  flight fares ").id).toBe("serpapi-flights:flights.search");
	expect(resources.resolveTool("flight_status").id).toBe("aviationstack:flights.status");
	expect(() => resources.resolveTool("flight")).toThrow("not in the environment catalog");
});
test("duplicate labels never select a provider or version implicitly; exact IDs still work", () => {
	const resources = new Resources();
	resources.options.push({ ...resources.options[0]!, id: "another:flights.search" });
	expect(() => resources.resolveTool("Research flight fares")).toThrow("ambiguous");
	expect(() => resources.resolveTool("flight_search")).toThrow("ambiguous");
	expect(resources.resolveTool("serpapi-flights:flights.search").id).toBe("serpapi-flights:flights.search");
});
test("unavailable labels produce setup guidance without becoming grants", () => {
	class Unavailable extends TeamResources {
		override catalog() {
			return [
				{
					id: "provider:read",
					name: "Provider: Read records",
					description: "",
					setup: "Connect Provider in Settings",
				},
			];
		}
	}
	expect(() => new Unavailable().resolveTool("Read records")).toThrow("Connect Provider");
});
