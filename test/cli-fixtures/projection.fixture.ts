import { projection } from "@lambda-house/teob-ts/projection";

// TODO: import your event types
// import type { MyEvent } from "../aggregates/my-aggregate.js";

// View type
export interface GiftCardSummaryView {
  // TODO: add view fields
}

export const giftCardSummaryProjection = projection({
  projectionId: "gift-card-summary",
  category: "TODO", // TODO: set source category

  initialState: (): GiftCardSummaryView => ({
    // TODO: set initial view state
  }),

  evolve: (view: GiftCardSummaryView, event: any, entityId): GiftCardSummaryView => {
    switch (event.tag) {
      // TODO: handle events
      // case "SomethingHappened":
      //   return { ...view, field: event.value };
      default:
        return view;
    }
  },
});
