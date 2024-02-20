import errors from "./errors";

interface IRpcErrorLUT {
	[key: string]: new (message?: string) => Error;
}

const rpcErrorLUT: IRpcErrorLUT = {
	GenericError: errors.RPCGenericError,
	NotImplemented: errors.RPCNotImplementedError,
	NotSupported: errors.RPCNotSupportedError,
	InternalError: errors.RPCInternalError,
	ProtocolError: errors.RPCProtocolError,
	SecurityError: errors.RPCSecurityError,
	FormationViolation: errors.RPCFormationViolationError,
	FormatViolation: errors.RPCFormatViolationError,
	PropertyConstraintViolation: errors.RPCPropertyConstraintViolationError,
	OccurenceConstraintViolation: errors.RPCOccurenceConstraintViolationError,
	OccurrenceConstraintViolation: errors.RPCOccurrenceConstraintViolationError,
	TypeConstraintViolation: errors.RPCTypeConstraintViolationError,
	MessageTypeNotSupported: errors.RPCMessageTypeNotSupportedError,
	RpcFrameworkError: errors.RPCFrameworkError,
};

export function getPackageIdent() {
	return `yano-cms/v1 (${process.platform})`;
}

export function getErrorPlainObject(err: Error) {
	try {
		// (nasty hack)
		// attempt to serialise into JSON to ensure the error is, in fact, serialisable
		return JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
	} catch (e) {
		// cannot serialise into JSON.
		// return just stack and message instead
		return {
			stack: err.stack,
			message: err.message,
		};
	}
}

export function createRPCError(type: string, message?: any, details?: {}) {
	const E = rpcErrorLUT[type] ?? rpcErrorLUT.GenericError;
	const err: Record<string, any> = new E(message ?? "");
	err.details = details ?? {};
	return err;
}

export default {
	getErrorPlainObject,
	createRPCError,
	getPackageIdent,
};
