// @flow strict

import { sortBy } from 'lodash';

/**
 * The ModuleBuilder is a helper that is instantiated on a per-module basis.
 * While generating code, one might need to register an import statement as
 * a side effect to make the emitted code valid.  To do this, use either of the
 * ModuleBuilder's methods.
 */
export default class ModuleBuilder {
    _headerComment: string;

    // Default imports are: "import x from y"
    _defaultImports: Map<string, string>;

    // Named imports are: "import { x } from y"
    _namedImports: Map<string, Set<string>>;

    // Namespace imports are: "import * as x from y"
    _namespaceImports: Map<string, string>;

    // Type imports are: "import type { x } from y"
    _typeImports: Map<string, Set<string>>;

    // A mapping of global variables, and functions that will produce them
    _defs: Map<string, (ModuleBuilder) => string>;
    _emittedDefs: Set<string>;
    _defCode: Array<string>;

    // A mapping of global type definitions, and functions that will produce them
    _typeDefs: Map<string, (ModuleBuilder) => string>;
    _emittedTypeDefs: Set<string>;
    _typeDefCode: Array<string>;

    // Mappings of exported definitions and types
    _exports: Set<string>;
    _typeExports: Set<string>;

    constructor(comment: string = '') {
        // These collections rougly represent the "sections", in the order by which
        // they're going to be outputted
        this._headerComment = comment;

        // Three different import styles
        this._namespaceImports = new Map();
        this._defaultImports = new Map();
        this._namedImports = new Map();
        this._typeImports = new Map();

        // Global definitions, like "const foo = 42"
        this._typeDefs = new Map();
        this._emittedTypeDefs = new Set();
        this._typeDefCode = [];

        // Global definitions, like "const foo = 42"
        this._defs = new Map();
        this._emittedDefs = new Set();
        this._defCode = [];

        // Keep track of what's exported
        this._exports = new Set();
        this._typeExports = new Set();
    }

    /**
     * Registers a factory for a specific JS definition.  You register it under
     * a unique key, and you can use that key whenever you emit some code that
     * depends on this definition, using .require()
     *
     * It works very similar to a regular .registerTypeDef(), but the key
     * difference is that it's emitted in a different "section" in the output.
     * (Type defs go first, then all code defs.)
     */
    registerDef(key: string, callback: ModuleBuilder => string) {
        if (this._defs.has(key)) {
            throw new Error(`Def "${key}" already registered. You can only register a definition once.`);
        }

        this._defs.set(key, callback);
    }

    /**
     * Registers a factory for a specific type definition.  You register it under
     * a unique key, and you can use that key whenever you emit some code that
     * depends on this definition, using .requireType()
     *
     * It works very similar to a regular .registerDef(), but the key difference
     * is that it's emitted in a different "section" in the output. (Type defs go
     * first, then all code defs.)
     */
    registerTypeDef(key: string, callback: ModuleBuilder => string) {
        if (this._typeDefs.has(key)) {
            throw new Error(`Type def "${key}" already registered. You can only register a type definition once.`);
        }

        this._typeDefs.set(key, callback);
    }

    require(key: string) {
        if (this._emittedDefs.has(key)) {
            return;
        }

        const callback = this._defs.get(key);
        if (!callback) {
            throw new Error(`Unknown def "${key}". Please register it with registerDef() before using it.`);
        }

        this._emittedDefs.add(key);
        const code: string = callback(this);
        this._defCode.push(code);
    }

    requireType(key: string) {
        if (this._emittedTypeDefs.has(key)) {
            return;
        }

        const callback = this._typeDefs.get(key);
        if (!callback) {
            throw new Error(`Unknown type def "${key}". Please register it with registerTypeDef() before using it.`);
        }

        this._emittedTypeDefs.add(key);
        const code: string = callback(this);
        this._typeDefCode.push(code);
    }

    /**
     * Emits a definition directly.  This is like registering a def, and
     * immediately requiring it, without the need to use an explicit key.
     */
    emit(codeOrCallback: string | (ModuleBuilder => string)) {
        const code: string = typeof codeOrCallback === 'string' ? codeOrCallback : codeOrCallback(this);
        this._defCode.push(code);
    }

    /**
     * Adds an import statement to the top of the module, of the following form:
     *
     *     import * as foo from "bar"
     *                 ^^^       ^^^
     *            identifier     from_
     */
    addNamespaceImport(identifier: string, from_: string) {
        this._namespaceImports.set(from_, identifier);
    }

    /**
     * Adds an import statement to the top of the module, of the following form:
     *
     *     import foo from "bar"
     *            ^^^       ^^^
     *       identifier     from_
     */
    addDefaultImport(identifier: string, from_: string) {
        this._defaultImports.set(from_, identifier);
    }

    /**
     * Adds an import statement to the top of the module, of the following form:
     *
     *     import { foo } from "bar"
     *              ^^^         ^^^
     *         identifier       from_
     *
     *  When this is called multiple times for the same `from_` value, the
     *  identifiers are unique'd and become part of the same import expression.
     */
    addNamedImport(identifier: string, from_: string) {
        const names = this._namedImports.get(from_) || new Set();
        names.add(identifier);
        this._namedImports.set(from_, names);
    }

    addTypeImport(identifier: string, from_: string) {
        const types = this._typeImports.get(from_) || new Set();
        types.add(identifier);
        this._typeImports.set(from_, types);
    }

    addExport(identifier: string) {
        this._exports.add(identifier);
    }

    addTypeExport(identifier: string) {
        this._typeExports.add(identifier);
    }

    getExports(): Set<string> {
        return this._exports;
    }

    getTypeExports(): Set<string> {
        return this._typeExports;
    }

    /**
     * Output [priority, module, line] tuples.  The [priority, module] part is
     * used to define the order by which the lines are sorted before being
     * outputted.  The [line] is the actual outputted line.
     */
    *iterImports(): Iterable<[number, string, string]> {
        for (const [module, identifier] of this._namespaceImports.entries()) {
            yield [0, identifier, `import * as ${identifier} from ${JSON.stringify(module)}`];
        }

        for (const [module, identifiers] of this._namedImports.entries()) {
            const sorted = sortBy([...identifiers], [i => i.toLowerCase()]);
            yield [
                1,
                // For named imports, our ESlint rule sorts the entire import line by
                // the first named identifier imported, not the module name :(
                sorted[0],
                `import { ${sorted.join(', ')} } from ${JSON.stringify(module)}`,
            ];
        }

        for (const [module, identifier] of this._defaultImports.entries()) {
            yield [2, identifier, `import ${identifier} from ${JSON.stringify(module)}`];
        }

        for (const [module, identifiers] of this._typeImports.entries()) {
            const sorted = sortBy([...identifiers], [i => i.toLowerCase()]);
            yield [
                3,
                // For type imports, our ESlint rule sorts the entire import line by
                // the first named identifier imported, not the module name :(
                sorted[0],
                `import type { ${sorted.join(', ')} } from ${JSON.stringify(module)}`,
            ];
        }
    }

    toString(): string {
        const importLines = sortBy(
            [...this.iterImports()],
            [
                // Sort by priority then by name
                ([priority]) => priority,
                ([, m]) => m.toLowerCase(),
            ]
        ).map(([, , line]) => line);
        const typeDefLines = this._typeDefCode.map(code => `${code}\n`);
        const defLines = this._defCode.map(code => `${code}\n`);
        return [this._headerComment, '', ...importLines, '', ...typeDefLines, '', ...defLines].join('\n');
    }
}
