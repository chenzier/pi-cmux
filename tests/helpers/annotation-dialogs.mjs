// Bridge tests automatically traverse review pages, but leave final approval pending.
// Page navigation, rendering, cancellation and approval gating are tested separately.
export function reviewSelect(confirm) {
	let pages = [];
	return (message, choices, options) => {
		pages.push(message);
		if (choices.includes("Next page")) return Promise.resolve("Next page");
		const review = pages.join("\n");
		pages = [];
		return confirm(review, choices, options);
	};
}
