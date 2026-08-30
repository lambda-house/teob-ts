import { CategoryId } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";

// TODO: Define your flow places, transitions, and commands
// See src/petrinet/ for FlowSchema and flowAggregate APIs

// Places (states in the flow)
export type OrderFulfillmentPlace = "initial" | "completed"; // TODO: add places

// Flow category
export const orderFulfillmentCategory = CategoryId("order-fulfillment");

// Codecs
// export const orderFulfillmentEventCodec = tagCodec<OrderFulfillmentEvent>(...);
// export const orderFulfillmentStateCodec = objectCodec<FlowState<OrderFulfillmentPlace>>("OrderFulfillmentFlowState");
