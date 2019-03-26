// @flow strict

import { sortBy } from 'lodash';
import chalk from 'chalk';
import fs from 'fs';
import mkdirp from 'mkdirp-promise';
import path from 'path';
import prettier from 'prettier';
import util from 'util';

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const readdir: string => Promise<Array<string>> = util.promisify(fs.readdir);
const projRoot = path.resolve(__dirname, '../../..');
const relative = (f: string): string => path.relative('.', f);

/**
 * Read utf-8 encoded text file contents.
 */
export async function read(file: string): Promise<string> {
    return await readFile(file, { encoding: 'utf-8' });
}

export function logEmittedOutputFile(file: string): void {
    const relpath = path.relative(projRoot, file);
    console.log(`Wrote ${chalk.green(relpath)}`);
}

export function prettify(code: string): string {
    return prettier.format(code, {
        parser: 'babel',
        singleQuote: true,
        trailingComma: 'all',
    });
}

export async function writeCode(code: string, outputFileName: string): Promise<void> {
    // Write the index file that lists all of the generated objects and types for
    // easier importing
    const formattedCode = prettify(code);
    await write(outputFileName, formattedCode);
}

/**
 * Write string contents to utf-8 encoded text file.
 */
export async function write(filename: string, contents: string): Promise<void> {
    await mkdirp(path.dirname(filename));
    await writeFile(filename, contents);
    logEmittedOutputFile(filename);
}

/**
 * Compares all files in the given directory matching the given pattern to the
 * list of expected files and reports about differences.  Returns whether the
 * expected files match.
 */
export async function checkOutputDir(dir: string, pattern: RegExp, expectedFiles: Array<string>): Promise<boolean> {
    // Work with full paths only
    const expected = new Set(expectedFiles.map(f => path.resolve(dir, f)));

    const unexpected: Array<string> = sortBy(
        (await readdir(dir))
            .map(f => path.resolve(dir, f)) // Work with full paths only
            .filter(f => f.match(pattern))

            // Filter out expected files
            .filter(f => !expected.has(f))
    );

    if (unexpected.length > 0) {
        console.error();
        console.error(`${chalk.yellow('Warning:')} Unexpected files found in output directory.`);
        console.error('Please rename or delete the following files:');
        for (const f of unexpected) {
            console.error(`- ${chalk.yellow(relative(path.resolve(dir, f)))}`);
        }
        console.error();
        return false;
    }

    return true;
}
