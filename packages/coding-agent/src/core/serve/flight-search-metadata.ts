import type { CapabilityProviderMetadata } from "./capability-provider-contract.ts";

export const FLIGHT_SEARCH_METADATA: CapabilityProviderMetadata = {
	definitions: [
		{
			id: "flights.status",
			version: 1,
			name: "Flight status and arrivals",
			description:
				"Look up current flight status, airport arrivals/departures, flight numbers and reported aircraft details using Aviationstack. Does not return ticket prices.",
			category: "data",
			effect: "read",
			defaultApproval: "never",
		},
		{
			id: "flights.search",
			version: 1,
			name: "Research flight fares",
			description:
				"Search dated flight itineraries, prices, airlines, flight numbers and layovers through SerpApi Google Flights. Not live flight status or booking.",
			category: "data",
			effect: "read",
			defaultApproval: "never",
		},
	],
	providers: [
		{
			id: "aviationstack",
			name: "Aviationstack",
			source: "builtin:aviationstack",
			version: "1",
			permissions: ["flight status network read", "Aviationstack request quota"],
			authentication: {
				kind: "environment",
				fields: [
					{
						env: "AVIATIONSTACK_API_KEY",
						label: "Aviationstack API key (aviationstack.com/dashboard)",
						required: true,
						secret: true,
					},
				],
			},
			bindings: [
				{
					capabilityId: "flights.status",
					capabilityVersion: 1,
					toolName: "flight_status",
					executors: ["session", "harness"],
				},
			],
		},
		{
			id: "serpapi-flights",
			name: "SerpApi Google Flights",
			source: "builtin:serpapi-flights",
			version: "1",
			permissions: ["flight search network read", "SerpApi search quota"],
			authentication: {
				kind: "environment",
				fields: [
					{
						env: "SERPAPI_API_KEY",
						label: "SerpApi API key (serpapi.com/manage-api-key)",
						required: true,
						secret: true,
					},
				],
			},
			bindings: [
				{
					capabilityId: "flights.search",
					capabilityVersion: 1,
					toolName: "flight_search",
					executors: ["session", "harness"],
				},
			],
		},
	],
};
