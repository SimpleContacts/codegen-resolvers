// @flow

import {
    GraphQLInputObjectType,
    GraphQLInterfaceType,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLSchema,
    GraphQLUnionType,
    buildSchema,
} from 'graphql';
import { checkOutputDir, read, writeCode } from './lib/io';
import { getExportsFromPath } from './lib/ast-helpers';
import { idispatch, odispatch } from './lib/graphql-dispatch';
import { lowerCaseFirst } from './lib/strings';
import { sortBy } from 'lodash';
import ModuleBuilder from './lib/ModuleBuilder';
import commander from 'commander';
import fs from 'fs';
import invariant from 'invariant';
import path from 'path';
import type { GraphQLArgument, GraphQLField, GraphQLInputType, GraphQLOutputType } from 'graphql';

type ProgramOptions = {|
    schemaFile: string,
    verbose: boolean,
|};

const HEADER_COMMENT = `
    // @flow

    /**
      * ----------------------- IMPORTANT -------------------------------
      *
      * The contents of this file are AUTOMATICALLY GENERATED.  Please do
      * not edit this file directly.  To modify its contents, make
      * changes to your GraphQL schema definition, and re-run:
      *
      *     $ generate-resolvers.js <schema>
      *
      * -----------------------------------------------------------------
      */
`;

/**
 * Given a "nullable" flow type expression, like "string | null", turn it into
 * the mandatory Flow type equivalent, by stripping off that " | null" suffix.
 * This may look like a super weird hack, and it kind of is, but it's being
 * enforced because in GraphQL every type is nullable, _unless_ it's make
 * nonnullable explicitly. (It's an unfortunate design decision on their part.)
 *
 * This means that if we traverse the schema, we may find a type of String,
 * which we thus convert to "string | null", only to later find out that it's
 * being wrapped in a nonnull type, which means we'll have to take off that
 * " | null" again.
 *
 * It's doable, but uglier than it needs to be.
 */
function nonOptional(baseTypeExpr: string): string {
    if (!baseTypeExpr.endsWith(' | null')) {
        throw new Error(`Expected type to end with " | null", but got: "${baseTypeExpr}"`);
    }

    // Strip off the " | null" suffix
    return baseTypeExpr.substring(0, baseTypeExpr.length - 7);
}

const ROOT_TYPES = new Set(['Query', 'Mutation']);
const BUILTINS = new Set(['Boolean', 'Float', 'ID', 'Int', 'String']);

function toFieldTypeDefinition(parentObj: GraphQLObjectType, field: GraphQLField<mixed, mixed>): string {
    // Resolver type args P, O, A
    const parent = ROOT_TYPES.has(parentObj.name) ? 'null' : parentObj.name;
    const output = toFlowOutputTypeRef(field.type);
    const args = field.args.length === 0 ? null : toFlowArgType(field.args);
    return `${field.name}: Resolver<${[parent, output, args].filter(Boolean).join(',')}>,`;
}

/**
 * Converts any GraphQLOutputType value into a matching resolver type
 * definition for Flow.  Example:
 *
 *    type Foo {
 *      id: String
 *      blah: Bar!
 *    }
 *
 * Would become:
 *
 *    export type FooResolver = {|
 *      id: Resolver<Foo, string | null>,
 *      blah: Resolver<Foo, Bar>,
 *    |};
 *
 */
function toResolverTypeDefinition(value: GraphQLOutputType): string {
    return odispatch(value, {
        onScalar: () => '', // Skip
        onInterface: () => '', // Skip
        onUnion: () => '', // Skip

        onObject: node => {
            const seen = new Set();

            // If this type implements any interfaces, emit a field for each
            // inherited field here now.  Nicely group these by interface in sections
            // with a leading comment.
            const sections = [];
            for (const iface of node.getInterfaces()) {
                const lines = [];
                lines.push('');
                lines.push(`// From ${iface.name}`);
                const ifields = iface.getFields();
                for (const ifieldName of Object.keys(ifields)) {
                    seen.add(ifieldName);
                    const ifield = ifields[ifieldName];
                    lines.push(toFieldTypeDefinition(node, ifield));
                }

                sections.push(lines.join('\n'));
            }

            const fields = node.getFields();
            return [
                `export type ${node.name}Resolver = {|`,
                ...sections,
                ...Object.keys(fields)
                    .filter(name => !seen.has(name))
                    .map(name => {
                        const field = fields[name];
                        return toFieldTypeDefinition(node, field);
                    }),
                '|}',
            ].join('\n');
        },

        onEnum: node => {
            const def = node
                .getValues()
                .map(entry => {
                    return `| ${JSON.stringify(entry.value)}\n`;
                })
                .join('\n');
            return `export type ${node.name} = \n${def}`;
        },

        default: node => {
            throw new Error(`Not implemented: ${String(node)}`);
        },
    });
}

// NOTE: This is a bit of a hack. Find a better way.
const FLOW_SCALARS = {
    ID: 'string | number | null',
    String: 'string | null',
    Int: 'number | null',
    Float: 'number | null',
    Boolean: 'boolean | null',
};

/**
 * Returns a string representing the Flow type reference expression to the
 * given type.
 */
// TODO: DO NOT EXPORT THIS HERE, BUT MAKE IT A SHARED LIBRARY!
export function toFlowOutputTypeRef(value: GraphQLOutputType): string {
    return odispatch(value, {
        onScalar: node => FLOW_SCALARS[node.name] || `${node.name} | null`,

        onNonNull: node => {
            const baseType = toFlowOutputTypeRef(node.ofType);
            return nonOptional(baseType);
        },

        onList: node => `Array<${toFlowOutputTypeRef(node.ofType)}> | null`,

        default: node => {
            const name = node.name || '';
            if (!name) {
                throw new Error(`Missing type name: ${String(node)}`);
            }
            return `${String(name)} | null`;
        },
    });
}

/**
 * Returns a string representing the Flow type definition expression to the
 * given type.
 */
function toFlowInputTypeDefinition(value: GraphQLInputType): string {
    return idispatch(value, {
        onObject: node => {
            const fields = node.getFields();
            return [
                '{|',
                ...Object.keys(fields).map(fieldName => {
                    const field = fields[fieldName];
                    return `+${fieldName}: ${toFlowInputTypeRef(field.type)},`;
                }),
                '|}',
            ].join('\n');
        },

        default: node => {
            throw new Error(`Missing type name: ${String(node)}`);
        },
    });
}

/**
 * Returns a string representing the Flow type reference expression to the
 * given type.
 */
function toFlowInputTypeRef(value: GraphQLInputType): string {
    return idispatch(value, {
        onScalar: node => FLOW_SCALARS[node.name] || `${node.name} | null`,

        onNonNull: node => {
            const baseType = toFlowInputTypeRef(node.ofType);
            return nonOptional(baseType);
        },

        onList: node => `Array<${toFlowInputTypeRef(node.ofType)}> | null`,

        default: node => {
            const name = node.name || '';
            if (!name) {
                throw new Error(`Missing type name: ${String(node)}`);
            }
            return `${String(name)} | null`;
        },
    });
}

function toFlowArgType(args: Array<GraphQLArgument>): string {
    const fieldExprs = args.map(arg => `+${arg.name}: ${toFlowInputTypeRef(arg.type)}`).join(', ');
    return `{| ${fieldExprs} |}`;
}

/**
 * Returns all named types from the schema, excluding any built-in types,
 * alphabetically sorted.
 */
function namedTypesFromSchema(schema: GraphQLSchema): Array<string> {
    const typeNames = Object.keys(schema.getTypeMap())
        .filter(name => !name.startsWith('__'))
        .filter(name => !BUILTINS.has(name));
    return sortBy(typeNames);
}

function isUnionOrInterfaceType(typename: string, schema: GraphQLSchema): boolean {
    const type = schema.getType(typename);
    return type instanceof GraphQLInterfaceType || type instanceof GraphQLUnionType;
}

/**
 * Writes Resolver Flow types to ./types/*.js
 */
async function writeResolverTypes(schema: GraphQLSchema, outputFile: string): Promise<void> {
    const typeDefs = schema.getTypeMap();
    const typeNames = namedTypesFromSchema(schema);

    const inputTypeDefs = typeNames
        .map(name => {
            const node = typeDefs[name];
            if (!(node instanceof GraphQLInputObjectType)) {
                // Skip
                return null;
            }

            return `type ${name} = ${toFlowInputTypeDefinition(node)};\n`;
        })
        .filter(Boolean);

    const resolverDefs = typeNames
        .filter(name => !(typeDefs[name] instanceof GraphQLUnionType))
        .map(name => {
            const node = typeDefs[name];
            if (node instanceof GraphQLInputObjectType) {
                // Skip these: they don't need a resolver
                return null;
            }
            return toResolverTypeDefinition(node);
        })
        .filter(Boolean);

    const scalarTypeNames = typeNames
        .filter(name => !BUILTINS.has(name))
        .filter(name => typeDefs[name] instanceof GraphQLScalarType);

    const modelNames = typeNames
        .filter(name => !ROOT_TYPES.has(name))
        .filter(name => typeDefs[name] instanceof GraphQLObjectType);

    const interfaceDefs = typeNames
        .filter(name => isUnionOrInterfaceType(name, schema))
        .map(name => {
            const concretes = getConcreteSubtypes(schema, name);
            return `
                export type ${name} = ${concretes.join(' | ')};
                export type ${name}$typename = ${concretes.map(n => JSON.stringify(n)).join(' | ')};
            `;
        });

    const mod = new ModuleBuilder(HEADER_COMMENT);
    mod.emit(() => {
        mod.addTypeImport('Context', '../context');
        mod.addTypeImport('GraphQLResolveInfo', 'graphql');
        for (const imp of scalarTypeNames) {
            mod.addTypeImport(imp, '../scalars');
        }
        for (const imp of modelNames) {
            mod.addTypeImport(imp, '../models');
        }

        return `
            type Resolver<P, T, A = {| ...null |}> = (
                parent: P,
                args: A,
                context: Context,
                info: GraphQLResolveInfo,
            ) => T | Promise<T>;

            ${interfaceDefs.join('\n\n')}
            ${inputTypeDefs.join('\n\n')}
            ${resolverDefs.join('\n\n')}
        `;
    });

    const code = mod.toString();
    await writeCode(code, outputFile);
}

/**
 * Writes a single resolver implementation file.
 */
async function writeResolverImpl(schema: GraphQLSchema, modelName: string, outputFile: string): Promise<void> {
    const exists = fs.existsSync(outputFile);
    if (exists) {
        // Don't touch an existing file
        return;
    }

    const instName = lowerCaseFirst(modelName);
    const resolverTypeName = `${modelName}Resolver`;
    const resolverInstanceName = lowerCaseFirst(resolverTypeName);

    const objType = schema.getType(modelName);
    invariant(objType, `Type ${modelName} not found in schema`);
    invariant(objType instanceof GraphQLObjectType, `Type ${modelName} expected to be of GraphQLObjectType`);

    // Keep a tally on which interface fields we've already outputted, so we
    // don't repeat them when we output the fields for the type itself
    const seen = new Set();

    // If this type implements any interfaces, emit a field for each
    // inherited field here now.  Nicely group these by interface in sections
    // with a leading comment.
    const sections = [];
    for (const iface of objType.getInterfaces()) {
        const lines = [];
        lines.push('');
        lines.push(`// From ${iface.name}`);
        const ifields = iface.getFields();
        for (const ifieldName of Object.keys(ifields)) {
            seen.add(ifieldName);
            lines.push(`${ifieldName}: ${instName} => ${instName}.${ifieldName},`);
        }

        sections.push(lines);
    }

    const fields = objType.getFields();
    const impl = [
        '{',
        ...sections.map(section => section.join('\n')),
        '',
        ...Object.keys(fields)
            .filter(name => !seen.has(name))
            .map(fieldName =>
                ROOT_TYPES.has(modelName)
                    ? `${fieldName}: (_, args, context) => {
                          // TODO: Replace this with your desired implementation
                      },`
                    : `${fieldName}: ${instName} => ${instName}.${fieldName},`
            ),
        '}',
    ].join('\n');

    const mod = new ModuleBuilder('// @flow');
    mod.addTypeImport(resolverTypeName, '../types');
    mod.emit(`const ${resolverInstanceName}: ${resolverTypeName} = ${impl};`);
    mod.emit(`export default ${resolverInstanceName};`);

    const code = mod.toString();
    await writeCode(code, outputFile);
}

/**
 * Write models scaffold.
 */
async function writeModelsScaffold(schema: GraphQLSchema, outputFile: string): Promise<void> {
    const modelNames = namedTypesFromSchema(schema)
        .filter(name => schema.getType(name) instanceof GraphQLObjectType)
        .filter(name => !ROOT_TYPES.has(name));

    const exists = fs.existsSync(outputFile);
    const origCode = !exists ? '// @flow\n\n' : await read(outputFile);

    const exportedTypes = exists ? new Set(await getExportsFromPath(outputFile)) : new Set();
    const missingModelNames = modelNames.filter(name => !exportedTypes.has(name));

    if (missingModelNames.length > 0) {
        const code = `
            ${origCode}

            ${missingModelNames
                .map(name => `export type ${name} = TODO; // TODO: Replace this with your own data type`)
                .join('\n')}
        `;
        await writeCode(code, outputFile);
    }
}

async function writeInterfaceImpls(schema: GraphQLSchema, outputDir: string): Promise<boolean> {
    const interfaces = namedTypesFromSchema(schema).filter(name => isUnionOrInterfaceType(name, schema));

    const files = await Promise.all(
        interfaces.map(async name => {
            const basename = `${name}.js`;
            const filename = path.resolve(outputDir, basename);
            await writeInterfaceImpl(schema, name, filename);
            return basename;
        })
    );

    return await checkOutputDir(outputDir, /.*\.js$/, files);
}

function getConcreteSubtypes(schema: GraphQLSchema, name: string): Array<string> {
    const type = schema.getType(name);
    const concretes =
        type instanceof GraphQLUnionType
            ? // For unions, we can directly query its "subtypes"
              type.getTypes().map(t => t.name)
            : // For interfaces, we cannot do it directly, but instead have to iterate all possible subtypes and check if they inherit from this interface
              namedTypesFromSchema(schema).filter(typename => {
                  const t = schema.getType(typename);
                  // Only keep object types that implement the current interface
                  return t instanceof GraphQLObjectType && t.getInterfaces().some(iface => iface.name === name);
              });
    return concretes;
}

/**
 * Write interface scaffold.
 */
async function writeInterfaceImpl(schema: GraphQLSchema, name: string, outputFile: string): Promise<void> {
    const exists = fs.existsSync(outputFile);
    if (exists) {
        // Don't touch this file, it's not owned by codegen anymore.  We _will_
        // check the exports of the file to see if they match expectations, though.
        const exports = new Set(await getExportsFromPath(outputFile));
        if (!exports.has('dispatch')) {
            throw new Error(`Error in ${outputFile}: module must implement a "dispatch" function`);
        }
        return;
    }

    const type = schema.getType(name);
    const concretes = getConcreteSubtypes(schema, name);

    const mod = new ModuleBuilder('// @flow');
    mod.addTypeImport(name, '../types');
    mod.addTypeImport(`${name}$typename`, '../types');

    mod.emit(`
        export function dispatch(value: ${name}): ${name}$typename {
            // TODO: Implement how to distinguish which concrete type "value" is
            ${concretes.map(c => `if (TODO) { return ${JSON.stringify(c)}; }`).join('\n else \n')}
            throw new Error('Unknown concrete type for ${
                type instanceof GraphQLUnionType ? 'union' : 'abstract interface'
            } type ${name}.');
        }
  `);

    const code = mod.toString();
    await writeCode(code, outputFile);
}

/**
 * Write scalars index.
 */
async function writeScalarsIndex(schema: GraphQLSchema, outputFile: string): Promise<string> {
    const modelNames = namedTypesFromSchema(schema)
        .filter(name => schema.getType(name) instanceof GraphQLScalarType)
        .filter(name => !BUILTINS.has(name));

    if (modelNames.length > 0) {
        const mod = new ModuleBuilder(HEADER_COMMENT);
        mod.emit(modelNames.map(name => `export type { ${name} } from './${name}';`).join('\n'));
        const code = mod.toString();
        await writeCode(code, outputFile);
    }

    return outputFile;
}

async function writeScalarImpls(schema: GraphQLSchema, outputDir: string): Promise<void> {
    const scalarNames = namedTypesFromSchema(schema).filter(
        model => schema.getType(model) instanceof GraphQLScalarType
    );

    const $files = [
        // The index.js file
        writeScalarsIndex(schema, path.resolve(outputDir, 'index.js')),

        // And all the scalars
        ...scalarNames.map(async name => {
            const basename = `${name}.js`;
            const filename = path.resolve(outputDir, basename);
            await writeScalarImpl(schema, name, filename);
            return filename;
        }),
    ];

    const files = await Promise.all($files);
    await checkOutputDir(outputDir, /.*\.js$/, files);
}

/**
 * Write scalars scaffold.
 */
async function writeScalarImpl(schema: GraphQLSchema, name: string, outputFile: string): Promise<void> {
    const exists = fs.existsSync(outputFile);
    if (exists) {
        // Don't touch this file, it's not owned by codegen anymore.  We _will_
        // check the exports of the file to see if they match expectations, though.
        const exports = new Set(await getExportsFromPath(outputFile));
        if (!exports.has(name)) {
            throw new Error(`Error in ${outputFile}: module must export a type named "${name}"`);
        }
        if (!exports.has('serialize')) {
            throw new Error(`Error in ${outputFile}: module must export a "serialize" function`);
        }
        if (!exports.has('decoder')) {
            throw new Error(`Error in ${outputFile}: module must export a "decoder" of type "Decoder<${name}>"`);
        }
        return;
    }

    const mod = new ModuleBuilder('// @flow');
    mod.addNamedImport('string', 'decoders');
    mod.addTypeImport('Decoder', 'decoders');
    mod.emit(`
        // TODO: Replace this type alias by the type you want to use internally
        export type ${name} = string;

        // Defines how ${name} values are serialized back in responses
        export const serialize: (${name}) => mixed = String;

        // TODO: Replace with existing decoder or define your own
        export const decoder: Decoder<${name}> = string;
    `);

    const code = mod.toString();
    await writeCode(code, outputFile);
}

/**
 * Write Context scaffold.
 */
async function writeContextScaffold(schema: GraphQLSchema, outputFile: string): Promise<void> {
    const exists = fs.existsSync(outputFile);
    const origCode = !exists ? '// @flow\n\n' : await read(outputFile);

    const exports = exists ? new Set(await getExportsFromPath(outputFile)) : new Set();

    let code = origCode;
    if (!exports.has('Context')) {
        code += `

            // TODO: Replace with your custom Context, as desired
            export type Context = mixed;
        `;
    }

    if (!exports.has('makeContext')) {
        code += `

            export function makeContext(req: express$Request): Context {
                // TODO: Implement your own initial context for the current request
                return null;
            }
        `;
    }

    if (code !== origCode) {
        await writeCode(code, outputFile);
    }
}

/**
 * Writes Resolver implementation scaffolds.
 */
async function writeResolverImpls(schema: GraphQLSchema, outputDir: string): Promise<boolean> {
    const modelNames = namedTypesFromSchema(schema).filter(model => schema.getType(model) instanceof GraphQLObjectType);

    const $files = [
        // The index.js file
        writeRootResolverImpl(schema, path.resolve(outputDir, 'index.js')),

        // The resolver files
        ...modelNames.map(async name => {
            const basename = `${name}Resolver.js`;
            const outputPath = path.resolve(outputDir, basename);
            await writeResolverImpl(schema, name, outputPath);
            return basename;
        }),
    ];

    const files = await Promise.all($files);
    return await checkOutputDir(outputDir, /(index|.*resolver)\.js$/i, files);
}

/**
 * Writes root resolver implementation to ./resolvers/index.js
 */
async function writeRootResolverImpl(schema: GraphQLSchema, outputFile: string): Promise<string> {
    const modelNames = namedTypesFromSchema(schema);

    const mod = new ModuleBuilder(HEADER_COMMENT);
    mod.emit(() => {
        const resolverNames = modelNames.filter(model => schema.getType(model) instanceof GraphQLObjectType);
        const scalarNames = modelNames.filter(model => schema.getType(model) instanceof GraphQLScalarType);
        const interfaceNames = modelNames.filter(name => isUnionOrInterfaceType(name, schema));

        const scalarDecls = scalarNames
            .map(name => {
                const type = schema.getType(name);
                const descr = type ? type.description || '' : '';
                mod.addNamedImport('makeScalar', 'lib/graphql-tools');
                mod.addNamespaceImport(name, `../scalars/${name}`);
                return `${name}: makeScalar('${name}', ${JSON.stringify(descr)}, ${name}.decoder, ${name}.serialize),`;
            })
            .join('\n');
        const interfaceDecls = interfaceNames
            .map(name => {
                mod.addNamespaceImport(name, `../interfaces/${name}`);
                return `${name}: { __resolveType: ${name}.dispatch },`;
            })
            .join('\n');
        const resolverDecls = resolverNames.map(name => `${name},`).join('\n');

        for (const name of resolverNames) {
            mod.addDefaultImport(name, `./${name}Resolver`);
        }

        return `
            const resolverMap = {
                ${resolverDecls ? '// Resolvers' : ''}
                ${resolverDecls}

                ${interfaceDecls ? '// Interfaces' : ''}
                ${interfaceDecls}

                ${scalarDecls ? '// Scalars' : ''}
                ${scalarDecls}
            };

            export default resolverMap;
        `;
    });

    const code = mod.toString();
    await writeCode(code, outputFile);
    return outputFile;
}

async function runWithOptions(options: ProgramOptions) {
    const schemaFile = options.schemaFile;
    const schemaDir = path.dirname(schemaFile);

    const schema = buildSchema(await read(schemaFile));

    const results = await Promise.all([
        writeResolverTypes(schema, path.resolve(schemaDir, 'types/index.js')),
        writeContextScaffold(schema, path.resolve(schemaDir, 'context/index.js')),
        writeModelsScaffold(schema, path.resolve(schemaDir, 'models/index.js')),
        writeScalarImpls(schema, path.resolve(schemaDir, 'scalars/')),
        writeInterfaceImpls(schema, path.resolve(schemaDir, 'interfaces/')),
        writeResolverImpls(schema, path.resolve(schemaDir, 'resolvers/')),
    ]);

    // If some of these generators returns an explicit falsey value, fail the
    // entire generator with a non-zero exit code
    if (!results.every(rv => rv === undefined || rv)) {
        process.exit(1);
    }
}

async function run(): Promise<void> {
    commander
        .usage('[options] <schema>')
        .description('Parses a GraphQL schema definition and generates type-safe resolvers for it.')
        .option('-v, --verbose', 'Be verbose')
        .parse(process.argv);

    // $FlowFixMe - options monkey-patched on commander are invisible to Flow
    const [schemaFile] = commander.args;
    if (!schemaFile) {
        commander.help();
    } else {
        // $FlowFixMe - options monkey-patched on commander are invisible to Flow
        const { verbose } = commander;
        await runWithOptions({ schemaFile, verbose });
    }
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
