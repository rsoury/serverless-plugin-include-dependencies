"use strict";

const path = require("path");

const precinct = require("precinct");
const resolve = require("resolve");
const readPkgUp = require("read-pkg-up");
const requirePackageName = require("require-package-name");
const glob = require("glob");

function ignoreMissing(dependency, optional) {
	return optional && dependency in optional;
}

module.exports = function(filename, serverless) {
	const servicePath = serverless.config.servicePath;
	const aliases = serverless.service.custom.moduleAliases || {};

	const filePaths = new Set();
	const modulePaths = new Set();

	const modulesToProcess = [];
	const localFilesToProcess = [filename];

	function handle(name, basedir, optionalDependencies) {
		const moduleName = requirePackageName(name.replace(/\\/, "/"));

		try {
			const pathToModule = resolve.sync(path.join(moduleName, "package.json"), {
				basedir
			});
			const pkg = readPkgUp.sync({ cwd: pathToModule });

			if (pkg) {
				modulesToProcess.push(pkg);
			}
		} catch (e) {
			if (e.code === "MODULE_NOT_FOUND") {
				if (ignoreMissing(moduleName, optionalDependencies)) {
					serverless.cli.log(
						`[serverless-plugin-include-dependencies]: WARNING missing optional dependency: ${moduleName}`
					);
					return null;
				}
				try {
					// this resolves the requested import also against any set up NODE_PATH extensions, etc.
					const resolved = require.resolve(name);
					localFilesToProcess.push(resolved);
					return;
				} catch (e) {
					throw new Error(
						`[serverless-plugin-include-dependencies]: Could not find ${moduleName}`
					);
				}
			}
			throw e;
		}
	}

	while (localFilesToProcess.length) {
		const currentLocalFile = localFilesToProcess.pop();

		if (filePaths.has(currentLocalFile)) {
			continue;
		}

		filePaths.add(currentLocalFile);

		precinct
			.paperwork(currentLocalFile, { includeCore: false })
			.map(dependency => {
				let resolvedDependency = dependency;
				Object.entries(aliases).forEach(([alias, aliasPath]) => {
					const chunks = dependency.split("/");
					const firstChunk = chunks.shift();
					if (firstChunk === alias) {
						const abs = resolve.sync(
							path.resolve(aliasPath, chunks.join("/")),
							{ basedir: servicePath }
						);
						resolvedDependency = path.relative(
							path.dirname(currentLocalFile),
							abs
						);
						if (resolvedDependency.split("/").length === 1) {
							resolvedDependency = `./${resolvedDependency}`;
						}
					}
				});
				return resolvedDependency;
			})
			.forEach(dependency => {
				if (dependency.indexOf(".") === 0) {
					const abs = resolve.sync(dependency, {
						basedir: path.dirname(currentLocalFile)
					});
					localFilesToProcess.push(abs);
				} else {
					handle(dependency, servicePath);
				}
			});
	}

	while (modulesToProcess.length) {
		const currentModule = modulesToProcess.pop();
		const currentModulePath = path.join(currentModule.path, "..");

		if (modulePaths.has(currentModulePath)) {
			continue;
		}

		modulePaths.add(currentModulePath);

		const packageJson = currentModule.pkg;

		["dependencies", "peerDependencies", "optionalDependencies"].forEach(
			key => {
				const dependencies = packageJson[key];

				if (dependencies) {
					Object.keys(dependencies).forEach(dependency => {
						handle(
							dependency,
							currentModulePath,
							packageJson.optionalDependencies
						);
					});
				}
			}
		);
	}

	modulePaths.forEach(modulePath => {
		const moduleFilePaths = glob.sync(path.join(modulePath, "**"), {
			nodir: true,
			ignore: path.join(modulePath, "node_modules", "**"),
			absolute: true
		});

		moduleFilePaths.forEach(moduleFilePath => {
			filePaths.add(moduleFilePath);
		});
	});

	return Array.from(filePaths);
};
