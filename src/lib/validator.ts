import Ajv, { AnySchema, AsyncSchema, SchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { createRPCError } from "./util";

const errorCodeLUT: { [key: string]: string } = {
	maximum: "FormatViolation",
	minimum: "FormatViolation",
	maxLength: "FormatViolation",
	minLength: "FormatViolation",
	exclusiveMaximum: "OccurenceConstraintViolation",
	exclusiveMinimum: "OccurenceConstraintViolation",
	multipleOf: "OccurenceConstraintViolation",
	maxItems: "OccurenceConstraintViolation",
	minItems: "OccurenceConstraintViolation",
	maxProperties: "OccurenceConstraintViolation",
	minProperties: "OccurenceConstraintViolation",
	additionalItems: "OccurenceConstraintViolation",
	required: "OccurenceConstraintViolation",
	pattern: "PropertyConstraintViolation",
	propertyNames: "PropertyConstraintViolation",
	additionalProperties: "PropertyConstraintViolation",
	type: "TypeConstraintViolation",
};

export class Validator {
	_subprotocol: string;
	_ajv: Ajv;
	constructor(subprotocol: string, ajv: Ajv) {
		this._subprotocol = subprotocol;
		this._ajv = ajv;
	}

	get subprotocol() {
		return this._subprotocol;
	}

	validate(schemaId: string, params: any) {
		const validator = this._ajv.getSchema(schemaId);

		if (!validator) {
			throw createRPCError(
				"ProtocolError",
				`Schema '${schemaId}' is missing from subprotocol schema '${this._subprotocol}'`,
			);
		}

		const res = validator(params);
		if (!res && validator.errors && validator.errors?.length > 0) {
			const [first] = validator.errors;
			const rpcErrorCode =
				errorCodeLUT[first.keyword] ?? "FormatViolation";

			throw createRPCError(
				rpcErrorCode,
				this._ajv.errorsText(validator.errors),
				{
					errors: validator.errors,
					data: params,
				},
			);
		}

		return res;
	}
}

export function createValidator(
	subprotocol: string,
	json: boolean | SchemaObject | AsyncSchema | AnySchema[],
) {
	const ajv = new Ajv({ strictSchema: false });
	addFormats(ajv);
	ajv.addSchema(json);

	ajv.removeKeyword("multipleOf");
	ajv.addKeyword({
		keyword: "multipleOf",
		type: "number",
		compile(schema) {
			return (data) => {
				const result = data / schema;
				const epsilon = 1e-6; // small value to account for floating point precision errors
				return Math.abs(Math.round(result) - result) < epsilon;
			};
		},
		errors: false,
		metaSchema: {
			type: "number",
		},
	});

	return new Validator(subprotocol, ajv);
}
