import { createValidator } from "./validator";

export default [
	createValidator("ocpp1.6", require("./schemas/ocpp1_6.json")),
	createValidator("ocpp2.0.1", require("./schemas/ocpp2_0_1.json")),
] as const;
