import { Result, success, error } from "../node_modules/typechat/dist/result";
// import { TypeChatJsonValidator } from "../node_modules/typechat/dist/typechat";
import { TypeChatLanguageModel, PromptSection, PromptContent } from "../node_modules/typechat/dist/model";

/**
 * Represents an object that can translate natural language requests in JSON objects of the given type.
 */
export interface Mythographer<T extends object> {
    model: TypeChatLanguageModel;                       // wrapper for the LLM we're using
    validator: TypeChatJsonValidator<T>;                // validator for the JSON schema

    /**
     * A boolean indicating whether to delete properties with null values from parsed JSON objects. Some language
     * models (e.g. gpt-3.5-turbo) have a tendency to assign null values to optional properties instead of omitting
     * them. The default for this property is `false`, but an application can set the property to `true` for schemas
     * that don't permit null values.
     */
    stripNulls:  boolean;

    /**
     * Creates an AI language model prompt from the given request. This function is called by `translate`
     * to obtain the prompt. An application can assign a new function to provide a different prompt.
     * @param request The natural language request.
     * @returns A prompt that combines the request with the schema and type name of the underlying validator.
     */
    createRequestPrompt(request: string): PromptContent;

    /**
     * Creates a prompt to request a modification to a JSON object.
     * Provides a json prompt and requests that a specific subset be modified. All changes are to made within that subset of the JSON object.
     * @param previousJSON 
     * @param modification 
     */
    createModificationPrompt(previousJSON: string, modification: string): string;

    /**
     * Creates a repair prompt to append to an original prompt/response in order to repair a JSON object that
     * failed to validate. An application can assign a new function
     * to provide a different repair prompt.
     * @param validationError The error message returned by the validator.
     * @returns A repair prompt constructed from the error message.
     */
    createRepairPrompt(previousJSON: string, validationError: string): string;

    /**
     * Optionally implements additional validation logic beyond what is expressed in the schema. This function is
     * called following successful schema validation of an instance. By default the function just returns a
     * `Success<T>` for the given instance, but an application can assign a new function that implements any
     * additional validation.
     * @param instance The instance to validate.
     * @returns A `Success<T>` with the final validated instance, or an `Error` explaining the validation failure.
     */
    validateInstance(instance: T): Result<T>;

    json_is_schema_valid(jsonObject: object): Result<T>;

    /**
     * Translates a natural language request into an object of type `T`. If the JSON object returned by
     * the language model fails to validate and the `attemptRepair` property is `true`, a second
     * attempt to translate the request will be made. The prompt for the second attempt will include the
     * diagnostics produced for the first attempt. This often helps produce a valid instance.
     * @param request The natural language request.
     * @param promptPreamble An optional string or array of prompt sections to prepend to the generated
     *   prompt. If a string is specified, it is converted into a single "user" role prompt section.
     * @returns A promise for the resulting object.
     */
    translate(request: string, promptPreamble?: string | PromptSection[]): Promise<Result<T>>;

    modify(previousJSON: object, modification: string, promptPreamble?: string | PromptSection[]): Promise<Result<T>>;

    repair(previousJSON: object, validationError: string, promptPreamble?: string | PromptSection[]): Promise<Result<T>>;
}

/**
 * An object that represents a TypeScript schema for JSON objects.
 */
export interface TypeChatJsonValidator<T extends object> {
    /**
     * Return a string containing TypeScript source code for the validation schema.
     */
    getSchemaText(): string;
    /**
     * Return the name of the JSON object target type in the schema.
     */
    getTypeName(): string;
    /**
     * Validates the given JSON object according to the associated TypeScript schema. Returns a
     * `Success<T>` object containing the JSON object if validation was successful. Otherwise, returns
     * an `Error` object with a `message` property describing the error.
     * @param jsonText The JSON object to validate.
     * @returns The JSON object or an error message.
     */
    validate(jsonObject: object): Result<T>;
}

/**
 * Creates an object that can translate natural language requests into JSON objects of the given type.
 * The specified type argument `T` must be the same type as `typeName` in the given `schema`. The function
 * creates a `TypeChatJsonValidator<T>` and stores it in the `validator` property of the returned instance.
 * @param model The language model to use for translating requests into JSON.
 * @param validator A string containing the TypeScript source code for the JSON schema.
 * @param typeName The name of the JSON target type in the schema.
 * @returns A `TypeChatJsonTranslator<T>` instance.
 */
export function createMythographer<T extends object>(model: TypeChatLanguageModel, validator: TypeChatJsonValidator<T>): Mythographer<T> {
    const translator: Mythographer<T> = {
        model,
        validator,
        stripNulls: false,
        createRequestPrompt,
        createRepairPrompt,
        createModificationPrompt,
        validateInstance: success,
        translate,
        json_is_schema_valid,
        modify,
        repair

    };
    return translator;

    function createRequestPrompt(request: string) {
        return `You are a service that translates user requests into JSON objects of type "${validator.getTypeName()}" according to the following TypeScript definitions:\n` +
            `\`\`\`\n${validator.getSchemaText()}\`\`\`\n` +
            `The following is a user request:\n` +
            `"""\n${request}\n"""\n` +
            `The following is the user request translated into a JSON object with 2 spaces of indentation and no properties with the value undefined:\n`;
    }

    function createModificationPrompt(previousJSON: string, modification: string) {
        return `You are a service that modifies JSON objects of type "${validator.getTypeName()}" according to the following TypeScript definitions:\n` +
            `\`\`\`\n${validator.getSchemaText()}\`\`\`\n` +
            `The following is a JSON object:\n` +
            `"""\n${previousJSON}\n"""\n` +
            `The following modification is to be made to the appropriate subset of the provided JSON object:\n` +
            `"""\n${modification}\n"""\n` +
            `Only the referenced or implied subset of the JSON should be modified. The rest should be same as the input.\n` +
            `The following is the modified JSON object with 2 spaces of indentation and no properties with the value undefined:\n`;
    }

    function createRepairPrompt(previousJSON: string, validationError: string) {
        return `You are a service that modifies JSON objects of type "${validator.getTypeName()}" according to the following TypeScript definitions:\n` +
            `\`\`\`\n${validator.getSchemaText()}\`\`\`\n` +
            `The following is a JSON object:\n` +
            `"""\n${previousJSON}\n"""\n` +
            `The JSON object is invalid for the following reason:\n` +
            `"""\n${validationError}\n"""\n` +
            `The following is a revised JSON object with 2 spaces of indentation and no properties with the value undefined:\n`;
    }

    function parse_json_response(responseText: string): Result<T> {
        const startIndex = responseText.indexOf("{");
        const endIndex = responseText.lastIndexOf("}");
        if (!(startIndex >= 0 && endIndex > startIndex)) {
            return error(`Response is not JSON:\n${responseText}`);
        }
        const jsonText = responseText.slice(startIndex, endIndex + 1);
        let jsonObject;
        try {
            jsonObject = JSON.parse(jsonText) as object;
        }
        catch (e) {
            return error(e instanceof SyntaxError ? e.message : "JSON parse error");
        }
        if (translator.stripNulls) {
            stripNulls(jsonObject);
        }
        return success(jsonObject as T);
    }

    function json_is_schema_valid(jsonObject: object): Result<T> {
        return translator.validator.validate(jsonObject);
    }

    async function translate(request: string, promptPreamble?: string | PromptSection[]) {
        const preamble: PromptSection[] = typeof promptPreamble === "string" ? [{ role: "user", content: promptPreamble }] : promptPreamble ?? [];
        let prompt: PromptSection[] = [...preamble, { role: "user", content: translator.createRequestPrompt(request) }];

        while (true) {
            const response = await model.complete(prompt);
            if (!response.success) {
                return response;
            }
            const responseText = response.data;

            return parse_json_response(responseText);
        }
    }

    async function modify(previousJSON: object, modification: string, promptPreamble?: string | PromptSection[]) {
        const prevJsonStr = JSON.stringify(previousJSON, null, 2);
        const preamble: PromptSection[] = typeof promptPreamble === "string" ? [{ role: "user", content: promptPreamble }] : promptPreamble ?? [];
        const prompt: PromptSection[] = [...preamble, { role: "user", content: translator.createModificationPrompt(prevJsonStr, modification) }];
        const response = await model.complete(prompt);
        if (!response.success) {
            return response;
        }

        return parse_json_response(response.data);
    }

    async function repair(previousJSON: object, validationError: string, promptPreamble?: string | PromptSection[]) {
        const prevJsonStr = JSON.stringify(previousJSON, null, 2);
        const preamble: PromptSection[] = typeof promptPreamble === "string" ? [{ role: "user", content: promptPreamble }] : promptPreamble ?? [];
        const prompt: PromptSection[] = [...preamble, { role: "user", content: translator.createRepairPrompt(prevJsonStr, validationError) }];
        const response = await model.complete(prompt);
        if (!response.success) {
            return response;
        }

        return parse_json_response(response.data);
    }
}

/**
 * Recursively delete properties with null values from the given object. This function assumes there are no
 * circular references in the object.
 * @param obj The object in which to strip null valued properties.
 */
function stripNulls(obj: any) {
    let keysToDelete: string[] | undefined;
    for (const k in obj) {
        const value = obj[k];
        if (value === null) {
            (keysToDelete ??= []).push(k);
        }
        else {
            if (Array.isArray(value)) {
                if (value.some(x => x === null)) {
                    obj[k] = value.filter(x => x !== null);
                }
            }
            if (typeof value === "object") {
                stripNulls(value);
            }
        }
    }
    if (keysToDelete) {
        for (const k of keysToDelete) {
            delete obj[k];
        }
    }
}
