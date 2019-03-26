// @flow

/**
 * This module provides convenient access to obtain a list of all identifiers
 * that are being exported in a certain JS module.  For example, suppose you
 * have a module containing:
 *
 *     export { Foo } from 'bar';
 *     export const foo = 123;
 *     export type Baz = { name: string };
 *     export function bar() {
 *     }
 *     export { Bar };
 *
 * Then getExportsFromPath('./mymodule.js') will return:
 *
 *     [ 'Bar', 'Baz', 'Foo', 'bar', 'foo' ]
 *
 */

// $FlowFixMe - parse() is missing type defs!
import { parse } from '@babel/parser';
import { read } from './io';
// $FlowFixMe - traverse() is missing type defs!
import traverse from '@babel/traverse';

const BABEL_PARSER_OPTIONS = { sourceType: 'module', plugins: ['flow'] };

async function astFromPath(path: string): Promise<mixed> {
    return parse(await read(path), BABEL_PARSER_OPTIONS);
}

/**
 * Returns a list of identifiers exported by the given AST.
 */
function getExportsFromAST(ast: mixed): Array<string> {
    const names: Array<string> = [];

    traverse(ast, {
        ExportNamedDeclaration(path) {
            const decl = path.node.declaration;

            // There are many different types of exports, each has their "id" value
            // stuck somewhere
            if (decl) {
                if (decl.type === 'VariableDeclaration') {
                    for (const v of decl.declarations) {
                        names.push(v.id.name);
                    }
                } else if (decl.type === 'FunctionDeclaration' || decl.type === 'TypeAlias') {
                    names.push(decl.id.name);
                }
            }

            for (const spec of path.node.specifiers) {
                names.push(spec.exported.name);
            }
        },
    });

    return names;
}

/**
 * Returns a list of identifier names exported by the given JS module.
 */
export async function getExportsFromPath(path: string): Promise<Array<string>> {
    const ast = await astFromPath(path);
    return getExportsFromAST(ast);
}
