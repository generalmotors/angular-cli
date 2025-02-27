/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { dirname, join, normalize, strings } from '@angular-devkit/core';
import {
  Rule,
  SchematicsException,
  Tree,
  apply,
  applyTemplates,
  chain,
  externalSchematic,
  mergeWith,
  move,
  noop,
  url,
} from '@angular-devkit/schematics';
import { Schema as UniversalOptions } from '@schematics/angular/universal/schema';
import { DependencyType, addDependency, updateWorkspace } from '@schematics/angular/utility';
import { JSONFile } from '@schematics/angular/utility/json-file';
import { isStandaloneApp } from '@schematics/angular/utility/ng-ast-utils';
import { targetBuildNotFoundError } from '@schematics/angular/utility/project-targets';
import { BrowserBuilderOptions } from '@schematics/angular/utility/workspace-models';
import * as ts from 'typescript';

import { latestVersions } from '../utility/latest-versions';
import {
  addInitialNavigation,
  findImport,
  getImportOfIdentifier,
  getOutputPath,
  getProject,
  stripTsExtension,
} from '../utility/utils';

import { Schema as AddUniversalOptions } from './schema';

const SERVE_SSR_TARGET_NAME = 'serve-ssr';
const PRERENDER_TARGET_NAME = 'prerender';

function addScriptsRule(options: AddUniversalOptions): Rule {
  return async (host) => {
    const pkgPath = '/package.json';
    const buffer = host.read(pkgPath);
    if (buffer === null) {
      throw new SchematicsException('Could not find package.json');
    }

    const serverDist = await getOutputPath(host, options.project, 'server');
    const pkg = JSON.parse(buffer.toString()) as { scripts?: Record<string, string> };
    pkg.scripts = {
      ...pkg.scripts,
      'dev:ssr': `ng run ${options.project}:${SERVE_SSR_TARGET_NAME}`,
      'serve:ssr': `node ${serverDist}/main.js`,
      'build:ssr': `ng build && ng run ${options.project}:server`,
      'prerender': `ng run ${options.project}:${PRERENDER_TARGET_NAME}`,
    };

    host.overwrite(pkgPath, JSON.stringify(pkg, null, 2));
  };
}

function updateWorkspaceConfigRule(options: AddUniversalOptions): Rule {
  return () => {
    return updateWorkspace((workspace) => {
      const projectName = options.project;
      const project = workspace.projects.get(projectName);
      if (!project) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const serverTarget = project.targets.get('server')!;
      (serverTarget.options ??= {}).main = join(normalize(project.root), 'server.ts');

      const serveSSRTarget = project.targets.get(SERVE_SSR_TARGET_NAME);
      if (serveSSRTarget) {
        return;
      }

      project.targets.add({
        name: SERVE_SSR_TARGET_NAME,
        builder: '@angular-devkit/build-angular:ssr-dev-server',
        defaultConfiguration: 'development',
        options: {},
        configurations: {
          development: {
            browserTarget: `${projectName}:build:development`,
            serverTarget: `${projectName}:server:development`,
          },
          production: {
            browserTarget: `${projectName}:build:production`,
            serverTarget: `${projectName}:server:production`,
          },
        },
      });

      const prerenderTarget = project.targets.get(PRERENDER_TARGET_NAME);
      if (prerenderTarget) {
        return;
      }

      project.targets.add({
        name: PRERENDER_TARGET_NAME,
        builder: '@angular-devkit/build-angular:prerender',
        defaultConfiguration: 'production',
        options: {
          routes: ['/'],
        },
        configurations: {
          production: {
            browserTarget: `${projectName}:build:production`,
            serverTarget: `${projectName}:server:production`,
          },
          development: {
            browserTarget: `${projectName}:build:development`,
            serverTarget: `${projectName}:server:development`,
          },
        },
      });
    });
  };
}

function updateServerTsConfigRule(options: AddUniversalOptions): Rule {
  return async (host) => {
    const project = await getProject(host, options.project);
    const serverTarget = project.targets.get('server');
    if (!serverTarget || !serverTarget.options) {
      return;
    }

    const tsConfigPath = serverTarget.options.tsConfig;
    if (!tsConfigPath || typeof tsConfigPath !== 'string') {
      // No tsconfig path
      return;
    }

    const tsConfig = new JSONFile(host, tsConfigPath);
    const filesAstNode = tsConfig.get(['files']);
    const serverFilePath = 'server.ts';
    if (Array.isArray(filesAstNode) && !filesAstNode.some(({ text }) => text === serverFilePath)) {
      tsConfig.modify(['files'], [...filesAstNode, serverFilePath]);
    }
  };
}

function routingInitialNavigationRule(options: UniversalOptions): Rule {
  return async (host) => {
    const project = await getProject(host, options.project);
    const serverTarget = project.targets.get('server');
    if (!serverTarget || !serverTarget.options) {
      return;
    }

    const tsConfigPath = serverTarget.options.tsConfig;
    if (!tsConfigPath || typeof tsConfigPath !== 'string' || !host.exists(tsConfigPath)) {
      // No tsconfig path
      return;
    }

    const parseConfigHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: ts.sys.readDirectory,
      fileExists: function (fileName: string): boolean {
        return host.exists(fileName);
      },
      readFile: function (fileName: string): string {
        return host.readText(fileName);
      },
    };
    const { config } = ts.readConfigFile(tsConfigPath, parseConfigHost.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config,
      parseConfigHost,
      dirname(normalize(tsConfigPath)),
    );
    const tsHost = ts.createCompilerHost(parsed.options, true);
    // Strip BOM as otherwise TSC methods (Ex: getWidth) will return an offset,
    // which breaks the CLI UpdateRecorder.
    // See: https://github.com/angular/angular/pull/30719
    tsHost.readFile = function (fileName: string): string {
      return host.readText(fileName).replace(/^\uFEFF/, '');
    };
    tsHost.directoryExists = function (directoryName: string): boolean {
      // When the path is file getDir will throw.
      try {
        const dir = host.getDir(directoryName);

        return !!(dir.subdirs.length || dir.subfiles.length);
      } catch {
        return false;
      }
    };
    tsHost.fileExists = function (fileName: string): boolean {
      return host.exists(fileName);
    };
    tsHost.realpath = function (path: string): string {
      return path;
    };
    tsHost.getCurrentDirectory = function () {
      return host.root.path;
    };

    const program = ts.createProgram(parsed.fileNames, parsed.options, tsHost);
    const typeChecker = program.getTypeChecker();
    const sourceFiles = program
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile && !program.isSourceFileFromExternalLibrary(f));
    const printer = ts.createPrinter();
    const routerModule = 'RouterModule';
    const routerSource = '@angular/router';

    sourceFiles.forEach((sourceFile) => {
      const routerImport = findImport(sourceFile, routerSource, routerModule);
      if (!routerImport) {
        return;
      }

      ts.forEachChild(sourceFile, function visitNode(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.name.text === 'forRoot'
        ) {
          const imp = getImportOfIdentifier(typeChecker, node.expression.expression);

          if (imp && imp.name === routerModule && imp.importModule === routerSource) {
            const print = printer.printNode(
              ts.EmitHint.Unspecified,
              addInitialNavigation(node),
              sourceFile,
            );

            const recorder = host.beginUpdate(sourceFile.fileName);
            recorder.remove(node.getStart(), node.getWidth());
            recorder.insertRight(node.getStart(), print);
            host.commitUpdate(recorder);

            return;
          }
        }

        ts.forEachChild(node, visitNode);
      });
    });
  };
}

function addDependencies(): Rule {
  return (_host: Tree) => {
    return chain([
      addDependency('express', latestVersions['express'], {
        type: DependencyType.Default,
      }),
      addDependency('@types/express', latestVersions['@types/express'], {
        type: DependencyType.Dev,
      }),
    ]);
  };
}

function addServerFile(options: UniversalOptions, isStandalone: boolean): Rule {
  return async (host) => {
    const project = await getProject(host, options.project);
    const browserDistDirectory = await getOutputPath(host, options.project, 'build');

    return mergeWith(
      apply(url('./files'), [
        applyTemplates({
          ...strings,
          ...options,
          stripTsExtension,
          browserDistDirectory,
          isStandalone,
        }),
        move(project.root),
      ]),
    );
  };
}

export default function (options: AddUniversalOptions): Rule {
  return async (host) => {
    const project = await getProject(host, options.project);
    const universalOptions = {
      ...options,
      skipInstall: true,
    };
    const clientBuildTarget = project.targets.get('build');
    if (!clientBuildTarget) {
      throw targetBuildNotFoundError();
    }

    const clientBuildOptions = (clientBuildTarget.options ||
      {}) as unknown as BrowserBuilderOptions;

    const isStandalone = isStandaloneApp(host, clientBuildOptions.main);

    return chain([
      project.targets.has('server')
        ? noop()
        : externalSchematic('@schematics/angular', 'universal', universalOptions),
      addScriptsRule(options),
      updateServerTsConfigRule(options),
      updateWorkspaceConfigRule(options),
      isStandalone ? noop() : routingInitialNavigationRule(options),
      addServerFile(options, isStandalone),
      addDependencies(),
    ]);
  };
}
