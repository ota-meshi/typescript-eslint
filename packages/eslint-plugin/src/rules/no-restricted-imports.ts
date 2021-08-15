import ignore, { Ignore } from 'ignore';
import {
  AST_NODE_TYPES,
  TSESTree,
} from '@typescript-eslint/experimental-utils';
import { createRule, nullThrows, NullThrowsReasons } from '../util';

interface ObjectPathOption {
  name: string;
  importKind?: 'type' | 'value' | 'all';
  message?: string;
  importNames?: string[];
}
interface ObjectPatternOption {
  group: string[];
  importKind?: 'type' | 'value' | 'all';
  message?: string;
}
type PathOption = string | ObjectPathOption;
type PatternOption = string | ObjectPatternOption;
interface CompositeOption {
  paths?: PathOption[];
  patterns?: PatternOption[];
}
interface ParsedPathOption {
  name: string;
  importKind: 'type' | 'value' | 'all';
  importNames?: Set<string> | null;
  customMessage?: string;
}
interface ParsedPatternGroup {
  matcher: Ignore;
  importKind: 'type' | 'value' | 'all';
  customMessage?: string;
}

export type Options = PathOption[] | [CompositeOption];

type BaseMessageIds = 'path' | 'patterns' | 'everything' | 'importName';
export type MessageIds = BaseMessageIds | `${BaseMessageIds}WithCustomMessage`;

const PATH_OPTIONS_SCHEMA = {
  type: 'array' as const,
  items: {
    anyOf: [
      { type: 'string' as const },
      {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          importKind: { enum: ['type', 'value', 'all'] },
          message: {
            type: 'string' as const,
            minLength: 1,
          },
          importNames: {
            type: 'array' as const,
            items: {
              type: 'string' as const,
            },
          },
        },
        additionalProperties: false,
        required: ['name'],
      },
    ],
  },
  uniqueItems: true,
};

const PATTERN_OPTIONS_SCHEMA = {
  anyOf: [
    {
      type: 'array',
      items: {
        type: 'string',
      },
      uniqueItems: true,
    },
    {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: {
            type: 'array',
            items: {
              type: 'string',
            },
            minItems: 1,
            uniqueItems: true,
          },
          importKind: { enum: ['type', 'value', 'all'] },
          message: {
            type: 'string',
            minLength: 1,
          },
        },
        additionalProperties: false,
        required: ['group'],
      },
      uniqueItems: true,
    },
  ],
};

function isStringLiteral(
  node: TSESTree.Expression | null,
): node is TSESTree.StringLiteral {
  return (
    !!node &&
    node.type === AST_NODE_TYPES.Literal &&
    typeof node.value === 'string'
  );
}

function parseOptions(options: Options): {
  restrictedPaths: ParsedPathOption[];
  restrictedPatternGroups: ParsedPatternGroup[];
} {
  const restrictedPaths: ParsedPathOption[] = [];
  const restrictedPatternGroups: ParsedPatternGroup[] = [];

  for (const option of options) {
    if (isCompositeOption(option)) {
      for (const path of option.paths ?? []) {
        restrictedPaths.push(parsePathOption(path));
      }
      const stringPatterns: string[] = [];
      for (const pattern of option.patterns ?? []) {
        if (typeof pattern === 'string') {
          stringPatterns.push(pattern);
        } else {
          restrictedPatternGroups.push({
            matcher: ignore().add(pattern.group),
            importKind: pattern.importKind ?? 'all',
            customMessage: pattern.message,
          });
        }
      }
      if (stringPatterns.length) {
        restrictedPatternGroups.push({
          matcher: ignore().add(stringPatterns),
          importKind: 'all',
        });
      }
    } else {
      restrictedPaths.push(parsePathOption(option));
    }
  }

  return {
    restrictedPaths,
    restrictedPatternGroups,
  };

  function isCompositeOption(
    option: PathOption | CompositeOption,
  ): option is CompositeOption {
    return (
      typeof option !== 'string' && ('path' in option || 'patterns' in option)
    );
  }

  function parsePathOption(pathOption: PathOption): ParsedPathOption {
    if (typeof pathOption === 'string') {
      return { name: pathOption, importKind: 'all' };
    }
    return {
      name: pathOption.name,
      importKind: pathOption.importKind ?? 'all',
      importNames: pathOption.importNames?.length
        ? new Set(pathOption.importNames)
        : null,
      customMessage: pathOption.message,
    };
  }
}

export default createRule<Options, MessageIds>({
  name: 'no-restricted-imports',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow specified modules when loaded by `import`',
      category: 'Stylistic Issues',
      recommended: false,
      extendsBaseRule: true,
    },
    schema: {
      anyOf: [
        PATH_OPTIONS_SCHEMA,
        {
          type: 'array',
          items: [
            {
              type: 'object',
              properties: {
                paths: PATH_OPTIONS_SCHEMA,
                patterns: PATTERN_OPTIONS_SCHEMA,
              },
              additionalProperties: false,
            },
          ],
          additionalItems: false,
        },
      ],
    },
    messages: {
      path: "'{{importSource}}' {{importKindPhrase}} is restricted from being used.",
      pathWithCustomMessage:
        "'{{importSource}}' {{importKindPhrase}} is restricted from being used. {{customMessage}}",

      patterns:
        "'{{importSource}}' {{importKindPhrase}} is restricted from being used by a pattern.",
      patternsWithCustomMessage:
        "'{{importSource}}' {{importKindPhrase}} is restricted from being used by a pattern. {{customMessage}}",

      everything:
        "* {{importKindPhrase}} is invalid because '{{importNames}}' from '{{importSource}}' is restricted.",
      everythingWithCustomMessage:
        "* {{importKindPhrase}} is invalid because '{{importNames}}' from '{{importSource}}' is restricted. {{customMessage}}",

      importName:
        "'{{importName}}' {{importKindPhrase}} from '{{importSource}}' is restricted.",
      importNameWithCustomMessage:
        "'{{importName}}' {{importKindPhrase}} from '{{importSource}}' is restricted. {{customMessage}}",
    },
  },
  defaultOptions: ['never'],
  create(context) {
    const { restrictedPaths, restrictedPatternGroups } = parseOptions(
      context.options,
    );
    if (restrictedPaths.length === 0 && restrictedPatternGroups.length === 0) {
      return {};
    }

    const sourceCode = context.getSourceCode();

    function report({
      node,
      locs,
      baseMessageId,
      restricted,
      data,
    }: {
      node: TSESTree.Node;
      locs?: TSESTree.SourceLocation[];
      baseMessageId: BaseMessageIds;
      restricted: {
        importKind: 'type' | 'value' | 'all';
        customMessage?: string;
      };
      data: {
        importSource: string;
        importNames?: string;
        importName?: string;
      };
    }): void {
      const messageId: MessageIds = restricted.customMessage
        ? `${baseMessageId}WithCustomMessage`
        : baseMessageId;
      const importKindPhrase =
        restricted.importKind === 'type'
          ? 'type-only import'
          : restricted.importKind === 'value'
          ? 'import'
          : 'type-only import and import';
      if (locs) {
        for (const loc of locs) {
          context.report({
            node,
            messageId: messageId,
            loc: loc,
            data: {
              ...data,
              importKindPhrase,
              customMessage: restricted.customMessage,
            },
          });
        }
      } else {
        context.report({
          node,
          messageId: messageId,
          data: {
            ...data,
            importKindPhrase,
            customMessage: restricted.customMessage,
          },
        });
      }
    }

    function verify(
      node:
        | TSESTree.ImportDeclaration
        | TSESTree.ExportNamedDeclaration
        | TSESTree.ExportAllDeclaration,
      importKind: 'type' | 'value',
      generateImportNames: () => Iterable<{
        name: string;
        loc: TSESTree.SourceLocation;
      }>,
    ): void {
      if (!isStringLiteral(node.source)) {
        return;
      }
      const importSource = node.source.value.trim();

      // Check for restricted paths
      const restrictedPath = restrictedPaths.find(restrictedPath => {
        if (restrictedPath.name !== importSource) {
          return false;
        }
        return (
          restrictedPath.importKind === 'all' ||
          restrictedPath.importKind === importKind
        );
      });
      if (restrictedPath) {
        // Collect import names and report locations
        const importNames = new Map<string, TSESTree.SourceLocation[]>();
        for (const { name, loc } of generateImportNames()) {
          const locs = importNames.get(name);
          if (locs) {
            locs.push(loc);
          } else {
            importNames.set(name, [loc]);
          }
        }

        const restrictedImportNames = restrictedPath.importNames;
        if (restrictedImportNames) {
          for (const [name, locs] of importNames) {
            if (name === '*') {
              report({
                node,
                baseMessageId: 'everything',
                restricted: restrictedPath,
                locs,
                data: {
                  importSource,
                  importNames: [...restrictedImportNames].join(','),
                },
              });
            } else if (restrictedImportNames.has(name)) {
              report({
                node,
                baseMessageId: 'importName',
                restricted: restrictedPath,
                locs,
                data: {
                  importSource,
                  importName: name,
                },
              });
            }
          }
        } else {
          report({
            node,
            baseMessageId: 'path',
            restricted: restrictedPath,
            data: {
              importSource,
            },
          });
        }
      }

      // Check for restricted patterns
      for (const restrictedPatternGroup of restrictedPatternGroups) {
        if (
          restrictedPatternGroup.matcher.ignores(importSource) &&
          (restrictedPatternGroup.importKind === 'all' ||
            restrictedPatternGroup.importKind === importKind)
        ) {
          report({
            node,
            baseMessageId: 'patterns',
            restricted: restrictedPatternGroup,
            data: {
              importSource,
            },
          });
        }
      }
    }

    return {
      ImportDeclaration(node): void {
        verify(node, node.importKind, function* () {
          for (const specifier of node.specifiers) {
            if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
              yield { name: 'default', loc: specifier.loc };
            } else if (
              specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier
            ) {
              yield { name: '*', loc: specifier.loc };
            } else {
              // specifier.type === AST_NODE_TYPES.ImportSpecifier
              yield { name: specifier.imported.name, loc: specifier.loc };
            }
          }
        });
      },
      ExportNamedDeclaration(node): void {
        verify(node, node.exportKind, function* () {
          for (const specifier of node.specifiers) {
            yield { name: specifier.local.name, loc: specifier.loc };
          }
        });
      },
      ExportAllDeclaration(node): void {
        verify(node, node.exportKind, function* () {
          const starToken = nullThrows(
            sourceCode.getFirstToken(node, 1),
            NullThrowsReasons.MissingToken('*', node.type),
          );
          yield { name: '*', loc: starToken.loc };
        });
      },
    };
  },
});
