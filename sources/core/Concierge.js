import chalk            from 'chalk';
import fs               from 'fs';
import Joi              from 'joi';
import { camelCase }    from 'lodash';
import path             from 'path';

import { Command }      from './Command';
import { UsageError }   from './UsageError';
import * as flags       from './flags';
import { parse }        from './parse';

let standardOptions = [ {

    shortName: `h`,
    longName: `help`,

    argumentName: null,

} ];

function runMaybePromises(callbacks, returnIndex) {

    let results = new Array(callbacks.length);
    let promise = null;

    for (let t = 0; t < callbacks.length; ++t) {

        let callback = callbacks[t];

        if (promise) {

            promise = promise.then(() => {
                return Promise.resolve(callback()).then(result => {
                    results[t] = result;
                });
            });

        } else {

            let result = results[t] = callback();

            if (result && result.then) {
                promise = result.then(trueResult => {
                    results[t] = trueResult;
                });
            }

        }

    }

    if (promise) {

        return promise.then(() => {
            return results[returnIndex];
        });

    } else {

        return results[returnIndex];

    }

}

function getOptionString(options) {

    let basicOptions = [];
    let complexOptions = [];

    for (let option of options) {

        if (option.shortName && !option.longName && !option.argumentName) {
            basicOptions.push(option);
        } else {
            complexOptions.push(option);
        }

    }

    let basicString = basicOptions.length > 0 ? `[-${basicOptions.map(option => {

        return option.shortName;

    }).join(``)}]` : null;

    let complexString = complexOptions.map(option => {

        let names = [];

        if (option.shortName)
            names.push(`-${option.shortName}`);

        if (option.longName) {
            if (option.initialValue !== true) {
                names.push(`--${option.longName}`);
            } else if (option.longName.startsWith(`with-`)) {
                names.push(`--without-${option.longName.replace(/^with-/, ``)}`);
            } else {
                names.push(`--no-${option.longName}`);
            }
        }

        if (option.argumentName) {
            return `[${names.join(`,`)} ${option.argumentName}]`;
        } else {
            return `[${names.join(`,`)}]`;
        }

    }).join(` `);

    return [

        basicString,
        complexString

    ].join(` `);

}

export class Concierge {

    constructor() {

        this.commands = [];

        this.validators = {};
        this.options = standardOptions;

        this.beforeEachList = [];
        this.afterEachList = [];

    }

    beforeEach(callback) {

        this.beforeEachList.push(callback);

        return this;

    }

    afterEach(callback) {

        this.afterEachList.push(callback);

        return this;

    }

    topLevel(pattern) {

        let definition = parse(pattern);

        if (definition.path.length > 0)
            throw new Error(`The top-level pattern cannot have a command path; use command() instead`);

        if (definition.requiredArguments.length > 0)
            throw new Error(`The top-level pattern cannot have required arguments; use command() instead`);

        if (definition.optionalArguments.length > 0)
            throw new Error(`The top-level pattern cannot have optional arguments; use command() instead`);

        this.options = standardOptions.concat(definition.options);

        return this;

    }

    validate(optionName, validator) {

        this.validators[optionName] = validator;

        return this;

    }

    directory(startingPath, recursive = true, pattern = /\.js$/) {

        if (typeof IS_WEBPACK !== `undefined`) {

            if (typeof startingPath === `string`)
                throw new Error(`In webpack mode, you must use require.context to provide the directory content yourself; a path isn't enough`);

            for (let entry of startingPath.keys()) {

                let pkg = startingPath(entry);
                let factory = pkg.default || pkg;

                factory(this);

            }

        } else {

            let pathQueue = [ path.resolve(startingPath) ];
            let commandFiles = [];

            while (pathQueue.length > 0) {

                let currentPath = pathQueue.shift();
                let entries = fs.readdirSync(currentPath);

                for (let entry of entries) {

                    let entryPath = `${currentPath}/${entry}`;
                    let stat = fs.lstatSync(entryPath);

                    if (stat.isDirectory() && recursive)
                        pathQueue.push(entryPath);

                    if (stat.isFile() && entry.match(pattern)) {
                        commandFiles.push(entryPath);
                    }

                }

            }

            for (let commandPath of commandFiles) {

                let pkg = require(commandPath);
                let factory = pkg.default || pkg;

                factory(this);

            }

        }

    }

    command(pattern) {

        let definition = parse(pattern);

        if (definition.path.length === 0)
            throw new Error(`A command pattern cannot have an empty command path; use options() instead`);

        let command = new Command(this, definition);
        this.commands.push(command);

        return command;

    }

    error(error) {

        if (error instanceof UsageError) {
            console.log(`${chalk.red.bold(`Error`)}${chalk.bold(`:`)} ${error.message}`);
        } else {
            console.log(`${chalk.red.bold(`Error`)}${chalk.bold(`:`)} ${error.stack}`);
        }

    }

    usage(argv0, { command = null, error = null } = {}) {

        if (error) {
            this.error(error);
            console.log();
        }

        if (command) {

            let execPath = argv0 ? [].concat(argv0).join(` `) : `???`;

            let commandPath = command.path.join(` `);

            let requiredArguments = command.requiredArguments.map(name => `<${name}>`).join(` `);
            let optionalArguments = command.optionalArguments.map(name => `[${name}]`).join(` `);

            let globalOptions = getOptionString(this.options);
            let commandOptions = getOptionString(command.options);

            console.log(`${chalk.bold(`Usage:`)} ${execPath} ${globalOptions} ${commandPath} ${requiredArguments} ${optionalArguments} ${commandOptions}`.replace(/ +/g, ` `).trim());

            if (!error && command.description) {
                console.log();
                console.log(command.description);
            }

        } else {

            let execPath = argv0 ? [].concat(argv0).join(` `) : `???`;

            let globalOptions = getOptionString(this.options);

            console.log(`${chalk.bold(`Usage:`)} ${execPath} ${globalOptions} <command>`.replace(/ +/g, ` `).trim());

            let commands = this.commands.filter(command => (command.flags & flags.HIDDEN_COMMAND) === 0);

            if (commands.length > 0) {

                console.log();
                console.log(`${chalk.bold(`Where <command> is one of:`)}`);
                console.log();

                let maxPathLength = Math.max(0, ... commands.map(command => {
                    return command.path.join(` `).length;
                }));

                let pad = str => {
                    return `${str}${` `.repeat(maxPathLength - str.length)}`;
                };

                for (let command of commands) {
                    console.log(`  ${chalk.bold(pad(command.path.join(` `)))}  ${command.description}`);
                }

            }

        }

    }

    check() {

        if (this.commands.filter(command => command.flags & flags.DEFAULT_COMMAND).length > 1)
            throw new Error(`Multiple commands have been flagged as default command`);

        let shortNames = this.options.map(option => option.shortName).filter(name => name);
        let longNames = this.options.map(option => option.longName).filter(name => name);

        let topLevelNames = [].concat(shortNames, longNames);

        if (new Set(topLevelNames).size !== topLevelNames.length)
            throw new Error(`Some top-level parameter names are conflicting together`);

        for (let command of this.commands) {
            command.check(topLevelNames);
        }

    }

    run(argv0, argv, initialEnv = {}) {

        this.check();

        let env = { argv0 };
        let rest = [];

        for (let option of this.options) {

            if (option.longName) {

                if (Object.prototype.hasOwnProperty.call(initialEnv, option.longName)) {
                    env[option.longName] = initialEnv[option.longName];
                }

            } else {

                if (Object.prototype.hasOwnProperty.call(initialEnv, option.shortName)) {
                    env[option.shortName] = initialEnv[option.shortName];
                }

            }

        }

        let selectedCommand = this.commands.find(command => command.flags & flags.DEFAULT_COMMAND !== 0);
        let candidateCommands = this.commands;

        let commandPath = [];
        let commandBuffer = [];
        let isCommandLocked = false;

        let LONG_OPTION = 0;
        let SHORT_OPTION = 1;
        let STOP_OPTION = 2;
        let MALFORMED_OPTION = 3;
        let RAW_STRING = 4;

        let LONG_OPTION_REGEXP = /^--(?:(no|without)-)?([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)(?:(=)(.*))?$/;
        let SHORT_OPTION_REGEXP = /^-([a-zA-Z])(?:=(.*))?(.*)$/;

        function lockCommand() {

            if (isCommandLocked)
                return;

            if (!selectedCommand)
                throw new UsageError(`No commands match the arguments you've providen`);

            // We can save what's left of our command buffer into the argv array that will be providen to the command
            rest = commandBuffer.slice(commandPath.length);

            isCommandLocked = true;

        }

        function getShortOption(short) {

            return options.find(option => {
                return option.shortName === short;
            });

        }

        function getLongOption(long) {

            return options.find(option => {
                return option.longName === long;
            });

        }

        function parseArgument(literal) {

            if (literal === `--`)
                return { type: STOP_OPTION, literal };

            if (literal.startsWith(`--`)) {

                let match = literal.match(LONG_OPTION_REGEXP);

                if (match) {
                    return { type: LONG_OPTION, literal, enabled: !match[1], name: (match[1] === `without` ? `with-` : ``) + match[2], value: match[3] ? match[4] || `` : undefined };
                } else {
                    return { type: MALFORMED_OPTION, literal };
                }

            }

            if (literal.startsWith(`-`)) {

                let match = literal.match(SHORT_OPTION_REGEXP);

                if (match) {
                    return { type: SHORT_OPTION, literal, leading: match[1], value: match[2], rest: match[3] };
                } else {
                    return { type: MALFORMED_OPTION, literal };
                }

            }

            return { type: RAW_STRING, literal };

        }

        try {

            let parsedArgv = argv.map(arg => parseArgument(arg));

            for (let t = 0, T = parsedArgv.length; t < T; ++t) {

                let current = parsedArgv[t];
                let next = parsedArgv[t + 1];

                switch (current.type) {

                    case MALFORMED_OPTION: {

                        throw new UsageError(`Malformed option "${current.literal}"`);

                    } break;

                    case STOP_OPTION: {

                        lockCommand();

                        for (t = t + 1; t < T; ++t) {
                            rest.push(parsedArgv[t].literal);
                        }

                    } break;

                    case SHORT_OPTION: {

                        let leadingOption = selectedCommand ? selectedCommand.options.find(option => option.shortName === current.leading) : null;

                        if (leadingOption)
                            lockCommand();
                        else
                            leadingOption = this.options.find(option => option.shortName === current.leading);

                        if (!leadingOption)
                            throw new UsageError(`Unknown option "${current.leading}"`);

                        if (leadingOption.argumentName) {

                            let value = current.value || current.rest || undefined;

                            if (!value && next && next.type === RAW_STRING) {
                                value = next.literal;
                                t += 1;
                            }

                            if (value === undefined)
                                throw new UsageError(`Option "${leadingOption.shortName}" cannot be used without argument`);

                            if (leadingOption.longName) {
                                env[camelCase(leadingOption.longName)] = value;
                            } else {
                                env[leadingOption.shortName] = value;
                            }

                        } else {

                            if (current.value)
                                throw new UsageError(`Option "${leadingOption.shortName}" doesn't expect any argument`);

                            if (!current.rest.match(/^[a-z0-9]*$/))
                                throw new UsageError(`Malformed option list "${current.literal}"`);

                            for (let optionName of [ current.leading, ... current.rest ]) {

                                let option = selectedCommand ? selectedCommand.options.find(option => option.shortName === optionName) : null;

                                if (option)
                                    lockCommand();
                                else
                                    option = this.options.find(option => option.shortName === optionName);

                                if (!option)
                                    throw new UsageError(`Unknown option "${optionName}"`);

                                if (option.argumentName)
                                    throw new UsageError(`Option "${optionName}" cannot be placed in an option list, because it expects an argument`);

                                if (option.maxValue !== undefined) {

                                    if (option.longName) {
                                        env[camelCase(option.longName)] = Math.min((env[camelCase(option.longName)] || option.initialValue) + 1, option.maxValue);
                                    } else {
                                        env[option.shortName] = Math.min((env[option.shortName] || option.initialValue) + 1, option.maxValue);
                                    }

                                } else {

                                    if (option.longName) {
                                        env[camelCase(option.longName)] = !option.initialValue;
                                    } else {
                                        env[option.shortName] = !option.initialValue;
                                    }

                                }

                            }

                        }

                    } break;

                    case LONG_OPTION: {

                        let option = selectedCommand ? selectedCommand.options.find(option => option.longName === current.name) : null;

                        if (option)
                            lockCommand();
                        else
                            option = this.options.find(option => option.longName === current.name);

                        if (!option)
                            throw new UsageError(`Unknown option "${current.name}"`);

                        let value;

                        if (option.argumentName) {

                            let disablePrefix = option.longName.startsWith(`with-`) ? `--without` : `--no`;

                            if (!current.enabled && current.value !== undefined)
                                throw new UsageError(`Option "${option.longName}" cannot have an argument when used with ${disablePrefix}`);

                            if (current.enabled) {

                                if (current.value !== undefined) {
                                    value = current.value;
                                } else if (next && next.type === RAW_STRING) {
                                    value = next.literal;
                                    t += 1;
                                } else {
                                    throw new UsageError(`Option "${option.longName}" cannot be used without argument. Use "${disablePrefix}-${option.longName}" instead`);
                                }

                            } else {

                                value = null;

                            }

                        } else {

                            if (current.value !== undefined)
                                throw new UsageError(`Option "${option.name}" doesn't expect any argument`);

                            if (current.enabled) {
                                value = true;
                            } else {
                                value = false;
                            }

                        }

                        if (option.longName) {
                            env[camelCase(option.longName)] = value;
                        } else {
                            env[option.shortName] = value;
                        }

                    } break;

                    case RAW_STRING: {

                        if (!isCommandLocked) {

                            let nextCandidates = candidateCommands.filter(command => command.path[commandBuffer.length] === current.literal);

                            commandBuffer.push(current.literal);

                            let nextSelectedCommand = nextCandidates.find(command => command.path.length === commandBuffer.length);

                            if (nextSelectedCommand) {
                                selectedCommand = nextSelectedCommand;
                                commandPath = commandBuffer;
                            }

                            candidateCommands = nextCandidates.filter(candidate => candidate !== nextSelectedCommand);

                            if ((selectedCommand && (selectedCommand.flags & flags.PROXY_COMMAND) !== 0) && next && next.type !== RAW_STRING) {

                                lockCommand();

                                for (t = t + 1; t < T; ++t) {
                                    rest.push(parsedArgv[t].literal);
                                }

                            } else if (candidateCommands.length === 0) {

                                lockCommand();

                            }

                        } else {

                            rest.push(current.literal);

                        }

                    } break;

                }

            }

            lockCommand();

            for (let name of selectedCommand.requiredArguments) {

                if (rest.length === 0)
                    throw new UsageError(`Missing required argument "${name}"`);

                env[camelCase(name)] = rest.shift();

            }

            for (let name of selectedCommand.optionalArguments) {

                if (rest.length === 0)
                    break;

                env[camelCase(name)] = rest.shift();

            }

            if (selectedCommand.spread)
                env[camelCase(selectedCommand.spread)] = rest;

            else if (rest.length > 0)
                throw new UsageError(`Too many arguments`);

            for (let option of [ ... selectedCommand.options, ... this.options ]) {

                let envName = option.longName
                    ? camelCase(option.longName)
                    : option.shortName;

                if (Object.prototype.hasOwnProperty.call(env, envName))
                    continue;

                env[envName] = option.initialValue;

            }

            let validationResults = Joi.validate(env, Joi.object().keys(Object.assign({}, this.validators, selectedCommand.validators)).unknown());

            if (validationResults.error) {

                if (validationResults.error.details.length > 1) {
                    throw new UsageError(`Validation failed because ${validationResults.error.details.slice(0, -1).map(detail => detail.message).join(`, `)}, and ${validationResults.error.details[validationResults.error.details.length - 1].message}`);
                } else {
                    throw new UsageError(`Validation failed because ${validationResults.error.details[0].message}`);
                }

            }

            env = validationResults.value;

            if (env.help) {

                if (commandPath.length > 0)
                    this.usage(argv0, { command: selectedCommand });
                else
                    this.usage(argv0);

                return 0;

            } else {

                let result = runMaybePromises([

                    ... this.beforeEachList.map(beforeEach => () => {
                        beforeEach(env);
                    }),

                    () => selectedCommand.run(env),

                    ... this.afterEachList.map(afterEach => () => {
                        afterEach(env);
                    }),

                ], this.beforeEachList.length);

                if (result && result.then) {

                    result = result.then(null, error => {

                        if (error instanceof UsageError) {
                            this.usage(argv0, { command: selectedCommand, error });
                            return 1;
                        } else {
                            throw error;
                        }

                    });

                }

                return result;

            }

        } catch (error) {

            if (error instanceof UsageError) {
                this.usage(argv0, { command: selectedCommand, error });
                return 1;
            } else {
                throw error;
            }

        }

        return undefined;

    }

    runExit(argv0, argv) {

        Promise.resolve(this.run(argv0, argv)).then(exitCode => {
            process.exit(exitCode);
        }, error => {
            this.error(error);
            process.exit(1);
        });

    }

}
