"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var extensions_exports = {};
__export(extensions_exports, {
  buildExtensionMedia: () => buildExtensionMedia,
  esbuildExtensions: () => esbuildExtensions,
  fromGithub: () => fromGithub,
  fromMarketplace: () => fromMarketplace,
  fromVsix: () => fromVsix,
  getBuildRootsForExtension: () => getBuildRootsForExtension,
  isWebExtension: () => isWebExtension,
  packageAllLocalExtensionsStream: () => packageAllLocalExtensionsStream,
  packageCopilotExtensionStream: () => packageCopilotExtensionStream,
  packageMarketplaceExtensionsStream: () => packageMarketplaceExtensionsStream,
  packageNativeLocalExtensionsStream: () => packageNativeLocalExtensionsStream,
  packageNonNativeLocalExtensionsStream: () => packageNonNativeLocalExtensionsStream,
  scanBuiltinExtensions: () => scanBuiltinExtensions,
  translatePackageJSON: () => translatePackageJSON,
  typeCheckExtension: () => typeCheckExtension,
  typeCheckExtensionStream: () => typeCheckExtensionStream
});
module.exports = __toCommonJS(extensions_exports);
var import_event_stream = __toESM(require("event-stream"), 1);
var import_fs = __toESM(require("fs"), 1);
var import_child_process = __toESM(require("child_process"), 1);
var import_glob = __toESM(require("glob"), 1);
var import_facade = require("./gulp/facade.ts");
var import_path = __toESM(require("path"), 1);
var import_crypto = __toESM(require("crypto"), 1);
var import_stream = require("stream");
var import_vinyl = __toESM(require("vinyl"), 1);
var import_stats = require("./stats.ts");
var util2 = __toESM(require("./util.ts"), 1);
var import_fancy_log = __toESM(require("fancy-log"), 1);
var import_ansi_colors = __toESM(require("ansi-colors"), 1);
var jsoncParser = __toESM(require("jsonc-parser"), 1);
var import_dependencies = require("./dependencies.ts");
var import_builtInExtensions = require("./builtInExtensions.ts");
var import_fetch = require("./fetch.ts");
var import_tsgo = require("./tsgo.ts");
var import_watch = __toESM(require("./watch/index.ts"), 1);
var import_module = require("module");
const import_meta = {};
const require2 = (0, import_module.createRequire)(import_meta.url);
const root = import_path.default.dirname(import_path.default.dirname(import_meta.dirname));
function minifyExtensionResources(input) {
  const jsonFilter = (0, import_facade.filter)(["**/*.json", "**/*.code-snippets"], { restore: true });
  return input.pipe(jsonFilter).pipe((0, import_facade.buffer)()).pipe(import_event_stream.default.mapSync((f) => {
    const errors = [];
    const value = jsoncParser.parse(f.contents.toString("utf8"), errors, { allowTrailingComma: true });
    if (errors.length === 0) {
      f.contents = Buffer.from(JSON.stringify(value));
    }
    return f;
  })).pipe(jsonFilter.restore);
}
function updateExtensionPackageJSON(input, update) {
  const packageJsonFilter = (0, import_facade.filter)("extensions/*/package.json", { restore: true });
  return input.pipe(packageJsonFilter).pipe((0, import_facade.buffer)()).pipe(import_event_stream.default.mapSync((f) => {
    const data = JSON.parse(f.contents.toString("utf8"));
    f.contents = Buffer.from(JSON.stringify(update(data)));
    return f;
  })).pipe(packageJsonFilter.restore);
}
function fromLocal(extensionPath, forWeb, _disableMangle) {
  let esbuildConfigFileName = forWeb ? "esbuild.browser.mts" : "esbuild.mts";
  let hasEsbuild = import_fs.default.existsSync(import_path.default.join(extensionPath, esbuildConfigFileName));
  if (!hasEsbuild && !forWeb) {
    for (const fallback of [".esbuild.mts", ".esbuild.ts"]) {
      if (import_fs.default.existsSync(import_path.default.join(extensionPath, fallback))) {
        esbuildConfigFileName = fallback;
        hasEsbuild = true;
        break;
      }
    }
  }
  let input;
  let isBundled = false;
  if (hasEsbuild) {
    const isStandardEsbuild = !esbuildConfigFileName.startsWith(".");
    input = isStandardEsbuild ? import_event_stream.default.merge(
      fromLocalEsbuild(extensionPath, esbuildConfigFileName),
      ...getBuildRootsForExtension(extensionPath).map((root2) => typeCheckExtensionStream(root2, forWeb))
    ) : fromLocalEsbuild(extensionPath, esbuildConfigFileName);
    isBundled = true;
  } else {
    input = fromLocalNormal(extensionPath);
  }
  if (isBundled) {
    input = updateExtensionPackageJSON(input, (data) => {
      delete data.scripts;
      delete data.dependencies;
      delete data.devDependencies;
      if (data.main) {
        data.main = data.main.replace("/out/", "/dist/");
      }
      return data;
    });
  }
  return input;
}
function typeCheckExtension(extensionPath, forWeb) {
  const tsconfigFileName = forWeb ? "tsconfig.browser.json" : "tsconfig.json";
  const tsconfigPath = import_path.default.join(extensionPath, tsconfigFileName);
  return (0, import_tsgo.spawnTsgo)(tsconfigPath, { taskName: "typechecking extension (tsgo)", noEmit: true });
}
function typeCheckExtensionStream(extensionPath, forWeb) {
  const tsconfigFileName = forWeb ? "tsconfig.browser.json" : "tsconfig.json";
  const tsconfigPath = import_path.default.join(extensionPath, tsconfigFileName);
  return (0, import_tsgo.createTsgoStream)(tsconfigPath, { taskName: "typechecking extension (tsgo)", noEmit: true });
}
function fromLocalNormal(extensionPath) {
  const vsce = require2("@vscode/vsce");
  const result = import_event_stream.default.through();
  vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Npm }).then((fileNames) => {
    const files = fileNames.map((fileName) => import_path.default.join(extensionPath, fileName)).map((filePath) => new import_vinyl.default({
      path: filePath,
      stat: import_fs.default.statSync(filePath),
      base: extensionPath,
      contents: import_fs.default.createReadStream(filePath)
    }));
    import_event_stream.default.readArray(files).pipe(result);
  }).catch((err) => result.emit("error", err));
  return result.pipe((0, import_stats.createStatsStream)(import_path.default.basename(extensionPath)));
}
function fromLocalEsbuild(extensionPath, esbuildConfigFileName) {
  const vsce = require2("@vscode/vsce");
  const result = import_event_stream.default.through();
  const extensionName = import_path.default.basename(extensionPath);
  const packagedDependenciesByExtension = {
    "git": ["@vscode/fs-copyfile"]
  };
  const packagedDependencies = packagedDependenciesByExtension[extensionName] ?? [];
  const esbuildScript = import_path.default.join(extensionPath, esbuildConfigFileName);
  new Promise((resolve, reject) => {
    const proc = import_child_process.default.execFile(process.argv[0], [esbuildScript], { cwd: extensionPath }, (error, _stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      const matches = (stderr || "").match(/\> (.+): error: (.+)?/g);
      (0, import_fancy_log.default)(`Bundled extension: ${import_ansi_colors.default.yellow(import_path.default.join(import_path.default.basename(extensionPath), esbuildConfigFileName))} with ${matches ? matches.length : 0} errors.`);
      for (const match of matches || []) {
        import_fancy_log.default.error(match);
      }
      return resolve();
    });
    proc.stdout.on("data", (data) => {
      (0, import_fancy_log.default)(`${import_ansi_colors.default.green("esbuilding")}: ${data.toString("utf8")}`);
    });
  }).then(() => {
    return vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.None });
  }).then((fileNames) => {
    if (packagedDependencies.length > 0) {
      const packagedDependencyFileNames = packagedDependencies.flatMap(
        (dependency) => import_glob.default.sync(import_path.default.join(extensionPath, "node_modules", dependency, "**"), { nodir: true, dot: true }).map((filePath) => import_path.default.relative(extensionPath, filePath)).filter((filePath) => {
          const parts = filePath.split(import_path.default.sep);
          const buildIndex = parts.indexOf("build");
          if (buildIndex !== -1) {
            return filePath.endsWith(".node");
          }
          return true;
        })
      );
      fileNames = Array.from(/* @__PURE__ */ new Set([...fileNames, ...packagedDependencyFileNames]));
    }
    const files = fileNames.map((fileName) => import_path.default.join(extensionPath, fileName)).map((filePath) => new import_vinyl.default({
      path: filePath,
      stat: import_fs.default.statSync(filePath),
      base: extensionPath,
      contents: import_fs.default.createReadStream(filePath)
    }));
    import_event_stream.default.readArray(files).pipe(result);
  }).catch((err) => {
    console.error(extensionPath);
    console.error(packagedDependencies);
    result.emit("error", err);
  });
  return result.pipe((0, import_stats.createStatsStream)(import_path.default.basename(extensionPath)));
}
const userAgent = "VSCode Build";
const baseHeaders = {
  "X-Market-Client-Id": "VSCode Build",
  "User-Agent": userAgent,
  "X-Market-User-Id": "291C1CD0-051A-4123-9B4B-30D60EF52EE2"
};
function fromMarketplace(serviceUrl, { name: extensionName, version, sha256, metadata }) {
  const [publisher, name] = extensionName.split(".");
  const url = `${serviceUrl}/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`;
  (0, import_fancy_log.default)("Downloading extension:", import_ansi_colors.default.yellow(`${extensionName}@${version}`), "...");
  const packageJsonFilter = (0, import_facade.filter)("package.json", { restore: true });
  return (0, import_fetch.fetchUrls)("", {
    base: url,
    nodeFetchOptions: {
      headers: baseHeaders
    },
    checksumSha256: sha256
  }).pipe(import_facade.vinylZip.src()).pipe((0, import_facade.filter)("extension/**")).pipe((0, import_facade.rename)((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe((0, import_facade.buffer)()).pipe((0, import_facade.jsonEditor)({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
function fromVsix(vsixPath, { name: extensionName, version, sha256, metadata }) {
  (0, import_fancy_log.default)("Using local VSIX for extension:", import_ansi_colors.default.yellow(`${extensionName}@${version}`), "...");
  const packageJsonFilter = (0, import_facade.filter)("package.json", { restore: true });
  return import_facade.gulp.src(vsixPath).pipe((0, import_facade.buffer)()).pipe(import_event_stream.default.mapSync((f) => {
    const hash = import_crypto.default.createHash("sha256");
    hash.update(f.contents);
    const checksum = hash.digest("hex");
    if (checksum !== sha256) {
      throw new Error(`Checksum mismatch for ${vsixPath} (expected ${sha256}, actual ${checksum}))`);
    }
    return f;
  })).pipe(import_facade.vinylZip.src()).pipe((0, import_facade.filter)("extension/**")).pipe((0, import_facade.rename)((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe((0, import_facade.buffer)()).pipe((0, import_facade.jsonEditor)({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
function fromGithub({ name, version, repo, sha256, metadata }, options) {
  const asset = options?.asset;
  const latest = options?.latest ?? false;
  (0, import_fancy_log.default)("Downloading extension from GH:", import_ansi_colors.default.yellow(`${name}@${latest ? "latest" : version}`), asset ? import_ansi_colors.default.gray(`(${asset.assetName})`) : "", "...");
  if (latest) {
    (0, import_fancy_log.default)(import_ansi_colors.default.yellow(`Warning: skipping checksum validation for ${name} (downloading latest release, no pinned checksum available)`));
  }
  const packageJsonFilter = (0, import_facade.filter)("package.json", { restore: true });
  return (0, import_fetch.fetchGithub)(new URL(repo).pathname, {
    version,
    name: asset ? asset.assetName : (name2) => name2.endsWith(".vsix"),
    // The checksum is tied to a specific version; when resolving the latest release the
    // downloaded asset differs, so it cannot be validated against the pinned checksum.
    checksumSha256: latest ? void 0 : asset ? asset.sha256 : sha256,
    latest
  }).pipe((0, import_facade.buffer)()).pipe(import_facade.vinylZip.src()).pipe((0, import_facade.filter)("extension/**")).pipe((0, import_facade.rename)((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe((0, import_facade.buffer)()).pipe((0, import_facade.jsonEditor)({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
const nativeExtensions = [
  "git",
  "microsoft-authentication"
];
const excludedExtensions = [
  "copilot",
  "vscode-api-tests",
  "vscode-colorize-tests",
  "vscode-colorize-perf-tests",
  "vscode-test-resolver",
  "ms-vscode.node-debug",
  "ms-vscode.node-debug2"
];
const marketplaceWebExtensionsExclude = /* @__PURE__ */ new Set([
  "ms-vscode.node-debug",
  "ms-vscode.node-debug2",
  "ms-vscode.js-debug-companion",
  "ms-vscode.js-debug",
  "ms-vscode.vscode-js-profile-table"
]);
const productJson = JSON.parse(import_fs.default.readFileSync(import_path.default.join(import_meta.dirname, "../../product.json"), "utf8"));
const builtInExtensions = productJson.builtInExtensions || [];
const webBuiltInExtensions = productJson.webBuiltInExtensions || [];
function isWebExtension(manifest) {
  if (Boolean(manifest.browser)) {
    return true;
  }
  if (Boolean(manifest.main)) {
    return false;
  }
  if (typeof manifest.extensionKind !== "undefined") {
    const extensionKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
    if (extensionKind.indexOf("web") >= 0) {
      return true;
    }
  }
  if (typeof manifest.contributes !== "undefined") {
    for (const id of ["debuggers", "terminal", "typescriptServerPlugins"]) {
      if (manifest.contributes.hasOwnProperty(id)) {
        return false;
      }
    }
  }
  return true;
}
function packageNonNativeLocalExtensionsStream(forWeb, disableMangle) {
  return doPackageLocalExtensionsStream(forWeb, disableMangle, false);
}
function packageNativeLocalExtensionsStream(forWeb, disableMangle) {
  return doPackageLocalExtensionsStream(forWeb, disableMangle, true);
}
function packageAllLocalExtensionsStream(forWeb, disableMangle) {
  return import_event_stream.default.merge([
    packageNonNativeLocalExtensionsStream(forWeb, disableMangle),
    packageNativeLocalExtensionsStream(forWeb, disableMangle)
  ]);
}
function doPackageLocalExtensionsStream(forWeb, disableMangle, native) {
  const nativeExtensionsSet = new Set(nativeExtensions);
  const localExtensionsDescriptions = import_glob.default.sync("extensions/*/package.json").map((manifestPath) => {
    const absoluteManifestPath = import_path.default.join(root, manifestPath);
    const extensionPath = import_path.default.dirname(import_path.default.join(root, manifestPath));
    const extensionName = import_path.default.basename(extensionPath);
    return { name: extensionName, path: extensionPath, manifestPath: absoluteManifestPath };
  }).filter(({ name }) => native ? nativeExtensionsSet.has(name) : !nativeExtensionsSet.has(name)).filter(({ name }) => excludedExtensions.indexOf(name) === -1).filter(({ name }) => builtInExtensions.every((b) => b.name !== name)).filter(({ manifestPath }) => forWeb ? isWebExtension(require2(manifestPath)) : true);
  const localExtensionsStream = minifyExtensionResources(
    import_event_stream.default.merge(
      ...localExtensionsDescriptions.map((extension) => {
        return fromLocal(extension.path, forWeb, disableMangle).pipe((0, import_facade.rename)((p) => p.dirname = `extensions/${extension.name}/${p.dirname}`));
      })
    )
  );
  let result;
  if (forWeb) {
    result = localExtensionsStream;
  } else {
    const productionDependencies = (0, import_dependencies.getProductionDependencies)("extensions/");
    const dependenciesSrc = productionDependencies.map((d) => import_path.default.relative(root, d)).map((d) => [`${d}/**`, `!${d}/**/{test,tests}/**`]).flat();
    if (dependenciesSrc.length) {
      result = import_event_stream.default.merge(
        localExtensionsStream,
        import_facade.gulp.src(dependenciesSrc, { base: "." }).pipe(util2.cleanNodeModules(import_path.default.join(root, "build", ".moduleignore"))).pipe(util2.cleanNodeModules(import_path.default.join(root, "build", `.moduleignore.${process.platform}`)))
      );
    } else {
      result = localExtensionsStream;
    }
  }
  return result.pipe(util2.setExecutableBit(["**/*.sh"]));
}
function packageCopilotExtensionStream(disableMangle) {
  const extensionPath = import_path.default.join(root, "extensions", "copilot");
  if (!import_fs.default.existsSync(extensionPath)) {
    return import_event_stream.default.readArray([]);
  }
  const localExtensionsStream = minifyExtensionResources(
    fromLocal(extensionPath, false, disableMangle).pipe((0, import_facade.rename)((p) => p.dirname = `extensions/copilot/${p.dirname}`))
  );
  const productionDependencies = (0, import_dependencies.getProductionDependencies)("extensions/copilot");
  const dependenciesSrc = productionDependencies.map((d) => import_path.default.relative(root, d)).map((d) => [`${d}/**`, `!${d}/**/{test,tests}/**`]).flat();
  return import_event_stream.default.merge(
    localExtensionsStream,
    import_facade.gulp.src(dependenciesSrc, { base: "." }).pipe(util2.cleanNodeModules(import_path.default.join(root, "build", ".moduleignore"))).pipe(util2.cleanNodeModules(import_path.default.join(root, "build", `.moduleignore.${process.platform}`)))
  ).pipe(util2.setExecutableBit(["**/*.sh"]));
}
function packageMarketplaceExtensionsStream(forWeb) {
  const marketplaceExtensionsDescriptions = [
    ...builtInExtensions.filter(({ name }) => forWeb ? !marketplaceWebExtensionsExclude.has(name) : true),
    ...forWeb ? webBuiltInExtensions : []
  ];
  const marketplaceExtensionsStream = minifyExtensionResources(
    import_event_stream.default.merge(
      ...marketplaceExtensionsDescriptions.map((extension) => {
        const src = (0, import_builtInExtensions.getExtensionStream)(extension).pipe((0, import_facade.rename)((p) => p.dirname = `extensions/${p.dirname}`));
        return updateExtensionPackageJSON(src, (data) => {
          delete data.scripts;
          delete data.dependencies;
          delete data.devDependencies;
          return data;
        });
      })
    )
  );
  return marketplaceExtensionsStream.pipe(util2.setExecutableBit(["**/*.sh"]));
}
function scanBuiltinExtensions(extensionsRoot, exclude = []) {
  const scannedExtensions = [];
  try {
    const extensionsFolders = import_fs.default.readdirSync(extensionsRoot);
    for (const extensionFolder of extensionsFolders) {
      if (exclude.indexOf(extensionFolder) >= 0) {
        continue;
      }
      const packageJSONPath = import_path.default.join(extensionsRoot, extensionFolder, "package.json");
      if (!import_fs.default.existsSync(packageJSONPath)) {
        continue;
      }
      const packageJSON = JSON.parse(import_fs.default.readFileSync(packageJSONPath).toString("utf8"));
      if (!isWebExtension(packageJSON)) {
        continue;
      }
      const children = import_fs.default.readdirSync(import_path.default.join(extensionsRoot, extensionFolder));
      const packageNLSPath = children.filter((child) => child === "package.nls.json")[0];
      const packageNLS = packageNLSPath ? JSON.parse(import_fs.default.readFileSync(import_path.default.join(extensionsRoot, extensionFolder, packageNLSPath)).toString()) : void 0;
      const readme = children.filter((child) => /^readme(\.txt|\.md|)$/i.test(child))[0];
      const changelog = children.filter((child) => /^changelog(\.txt|\.md|)$/i.test(child))[0];
      scannedExtensions.push({
        extensionPath: extensionFolder,
        packageJSON,
        packageNLS,
        readmePath: readme ? import_path.default.join(extensionFolder, readme) : void 0,
        changelogPath: changelog ? import_path.default.join(extensionFolder, changelog) : void 0
      });
    }
    return scannedExtensions;
  } catch (ex) {
    return scannedExtensions;
  }
}
function translatePackageJSON(packageJSON, packageNLSPath) {
  const CharCode_PC = "%".charCodeAt(0);
  const packageNls = JSON.parse(import_fs.default.readFileSync(packageNLSPath).toString());
  const translate = (obj) => {
    for (const key in obj) {
      const val = obj[key];
      if (Array.isArray(val)) {
        val.forEach(translate);
      } else if (val && typeof val === "object") {
        translate(val);
      } else if (typeof val === "string" && val.charCodeAt(0) === CharCode_PC && val.charCodeAt(val.length - 1) === CharCode_PC) {
        const translated = packageNls[val.substr(1, val.length - 2)];
        if (translated) {
          obj[key] = typeof translated === "string" ? translated : typeof translated.message === "string" ? translated.message : val;
        }
      }
    }
  };
  translate(packageJSON);
  return packageJSON;
}
const extensionsPath = import_path.default.join(root, "extensions");
async function esbuildExtensions(taskName, isWatch, scripts) {
  function reporter(stdError, script) {
    const matches = (stdError || "").match(/\> (.+): error: (.+)?/g);
    (0, import_fancy_log.default)(`Finished ${import_ansi_colors.default.green(taskName)} ${script} with ${matches ? matches.length : 0} errors.`);
    for (const match of matches || []) {
      import_fancy_log.default.error(match);
    }
  }
  const tasks = scripts.map(({ script, outputRoot }) => {
    return new Promise((resolve, reject) => {
      const args = [script];
      if (isWatch) {
        args.push("--watch");
      }
      if (outputRoot) {
        args.push("--outputRoot", outputRoot);
      }
      const proc = import_child_process.default.execFile(process.argv[0], args, {}, (error, _stdout, stderr) => {
        if (error) {
          return reject(error);
        }
        reporter(stderr, script);
        return resolve();
      });
      proc.stdout.on("data", (data) => {
        (0, import_fancy_log.default)(`${import_ansi_colors.default.green(taskName)}: ${data.toString("utf8")}`);
      });
    });
  });
  await Promise.all(tasks);
}
const esbuildMediaScripts = [
  { script: "ipynb/esbuild.notebook.mts", tsconfig: "ipynb/notebook-src/tsconfig.json" },
  { script: "markdown-language-features/esbuild.notebook.mts", tsconfig: "markdown-language-features/notebook/tsconfig.json" },
  { script: "markdown-language-features/esbuild.webview.mts", tsconfig: "markdown-language-features/preview-src/tsconfig.json" },
  { script: "markdown-language-features/esbuild.markdownEditor.mts", tsconfig: "markdown-language-features/markdown-editor-src/tsconfig.json" },
  { script: "markdown-math/esbuild.notebook.mts", tsconfig: "markdown-math/notebook/tsconfig.json" },
  { script: "mermaid-markdown-features/esbuild.webview.mts", tsconfig: "mermaid-markdown-features/preview-src/tsconfig.json" },
  { script: "notebook-renderers/esbuild.notebook.mts", tsconfig: "notebook-renderers/tsconfig.json" },
  { script: "simple-browser/esbuild.webview.mts", tsconfig: "simple-browser/preview-src/tsconfig.json" }
];
function buildExtensionMedia(isWatch, outputRoot) {
  const esbuildTask = esbuildExtensions("esbuilding extension media", isWatch, esbuildMediaScripts.map(({ script }) => ({
    script: import_path.default.join(extensionsPath, script),
    outputRoot: outputRoot ? import_path.default.join(root, outputRoot, import_path.default.dirname(script)) : void 0
  })));
  const typeCheckTasks = esbuildMediaScripts.map(({ tsconfig }) => {
    const tsconfigPath = import_path.default.join(extensionsPath, tsconfig);
    const config = { taskName: "typechecking extension media (tsgo)", noEmit: true };
    if (!isWatch) {
      return (0, import_tsgo.spawnTsgo)(tsconfigPath, config);
    } else {
      return watchTypeCheckExtensionMedia(tsconfigPath, config);
    }
  });
  return Promise.all([esbuildTask, ...typeCheckTasks]).then(() => void 0);
}
function watchTypeCheckExtensionMedia(tsconfigPath, config) {
  const srcDir = import_path.default.dirname(tsconfigPath);
  const watchInput = (0, import_watch.default)([
    import_path.default.join(srcDir, "**", "*.{ts,tsx,d.ts}"),
    tsconfigPath,
    "!" + import_path.default.join(srcDir, "**", "node_modules", "**"),
    "!" + import_path.default.join(srcDir, "**", "out", "**"),
    "!" + import_path.default.join(srcDir, "**", "dist", "**")
  ], { cwd: root, base: srcDir, dot: true, readDelay: 200 });
  const stream = watchInput.pipe(util2.debounce(() => {
    const tsgoStream = (0, import_tsgo.createTsgoStream)(tsconfigPath, config);
    const result = import_event_stream.default.through();
    tsgoStream.on("end", () => result.emit("end"));
    tsgoStream.on("error", () => result.emit("end"));
    return result;
  }, 200));
  return new Promise((_resolve, reject) => {
    stream.on("error", reject);
  });
}
function getBuildRootsForExtension(extensionPath) {
  if (extensionPath.endsWith("css-language-features") || extensionPath.endsWith("html-language-features") || extensionPath.endsWith("json-language-features")) {
    return [
      import_path.default.join(extensionPath, "client"),
      import_path.default.join(extensionPath, "server")
    ];
  }
  return [extensionPath];
}
