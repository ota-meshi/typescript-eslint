import {
  TSESLint,
  TSESTree,
  AST_TOKEN_TYPES,
  AST_NODE_TYPES,
} from '@typescript-eslint/experimental-utils';
import * as util from '../util';

type Prefer = 'type-imports' | 'no-type-imports' | 'type-imports-combine';

type Options = [
  {
    prefer?: Prefer;
    disallowTypeAnnotations?: boolean;
  },
];

function isImportToken(
  token: TSESTree.Token | TSESTree.Comment,
): token is TSESTree.KeywordToken & { value: 'import' } {
  return token.type === AST_TOKEN_TYPES.Keyword && token.value === 'import';
}

function isTypeToken(
  token: TSESTree.Token | TSESTree.Comment,
): token is TSESTree.IdentifierToken & { value: 'type' } {
  return token.type === AST_TOKEN_TYPES.Identifier && token.value === 'type';
}

function isDefaultSpecifier(
  specifier: TSESTree.ImportClause,
): specifier is TSESTree.ImportDefaultSpecifier {
  return specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier;
}

function isNamespaceSpecifier(
  specifier: TSESTree.ImportClause,
): specifier is TSESTree.ImportNamespaceSpecifier {
  return specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
}

function isNamedSpecifier(
  specifier: TSESTree.ImportClause,
): specifier is TSESTree.ImportSpecifier {
  return specifier.type === AST_NODE_TYPES.ImportSpecifier;
}

type MessageIds =
  | 'typeOverValue'
  | 'someImportsAreOnlyTypes'
  | 'aImportIsOnlyTypes'
  | 'valueOverType'
  | 'noImportTypeAnnotations'
  | 'duplicateTypeImports'
  | 'mustBeOneImport';
export default util.createRule<Options, MessageIds>({
  name: 'consistent-type-imports',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforces consistent usage of type imports',
      category: 'Stylistic Issues',
      recommended: false,
    },
    messages: {
      typeOverValue:
        'All imports in the declaration are only used as types. Use `import type`',
      someImportsAreOnlyTypes: 'Imports {{typeImports}} are only used as types',
      aImportIsOnlyTypes: 'Import {{typeImports}} is only used as types',
      valueOverType: 'Use an `import` instead of an `import type`.',
      noImportTypeAnnotations: '`import()` type annotations are forbidden.',
      duplicateTypeImports: '`import type` from the same source is  duplicated',
      mustBeOneImport:
        'Imports that use only types and imports that use values must be one import',
    },
    schema: [
      {
        type: 'object',
        properties: {
          prefer: {
            enum: ['type-imports', 'no-type-imports', 'type-imports-combine'],
          },
          disallowTypeAnnotations: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
    fixable: 'code',
  },

  defaultOptions: [
    {
      prefer: 'type-imports',
      disallowTypeAnnotations: true,
    },
  ],

  create(context, [option]) {
    const prefer = option.prefer ?? 'type-imports';
    const disallowTypeAnnotations = option.disallowTypeAnnotations !== false;

    return {
      ...(prefer === 'type-imports'
        ? createPreferTypeImportsVisitor(context)
        : prefer === 'no-type-imports'
        ? createPreferNoTypeImportsVisitor(context)
        : createPreferTypeImportsCombineVisitor(context)),
      ...(disallowTypeAnnotations
        ? {
            // disallow `import()` type
            TSImportType(node: TSESTree.TSImportType): void {
              context.report({
                node,
                messageId: 'noImportTypeAnnotations',
              });
            },
          }
        : {}),
    };
  },
});

/**
 * Create rule visitor for prefer 'type-imports'
 */
function createPreferTypeImportsVisitor(
  context: TSESLint.RuleContext<MessageIds, Options>,
): TSESLint.RuleListener {
  interface SourceImports {
    source: string;
    reportValueImports: ReportValueImport[];
    // ImportDeclaration for type-only import only with named imports.
    typeOnlyNamedImport: TSESTree.ImportDeclaration | null;
  }
  interface ReportValueImport {
    node: TSESTree.ImportDeclaration;
    typeSpecifiers: TSESTree.ImportClause[]; // It has at least one element.
    valueSpecifiers: TSESTree.ImportClause[];
    unusedSpecifiers: TSESTree.ImportClause[];
  }

  const sourceCode = context.getSourceCode();

  const sourceImportsMap: { [key: string]: SourceImports } = {};
  return {
    // prefer type imports
    ImportDeclaration(node: TSESTree.ImportDeclaration): void {
      const source = node.source.value as string;
      const sourceImports = (sourceImportsMap[source] ??= {
        source,
        reportValueImports: [],
        typeOnlyNamedImport: null,
      });
      if (node.importKind === 'type') {
        if (
          !sourceImports.typeOnlyNamedImport &&
          node.specifiers.every(isNamedSpecifier)
        ) {
          sourceImports.typeOnlyNamedImport = node;
        }
        return;
      }
      // if importKind === 'value'

      const {
        typeSpecifiers,
        valueSpecifiers,
        unusedSpecifiers,
      } = parseUsedKindSpecifierVariables(context, node);

      if (typeSpecifiers.length) {
        sourceImports.reportValueImports.push({
          node,
          typeSpecifiers,
          valueSpecifiers,
          unusedSpecifiers,
        });
      }
    },
    'Program:exit'(): void {
      for (const sourceImports of Object.values(sourceImportsMap)) {
        if (sourceImports.reportValueImports.length === 0) {
          continue;
        }
        for (const report of sourceImports.reportValueImports) {
          if (
            report.valueSpecifiers.length === 0 &&
            report.unusedSpecifiers.length === 0
          ) {
            // import is all type-only, convert the entire import to `import type`
            context.report({
              node: report.node,
              messageId: 'typeOverValue',
              *fix(fixer) {
                yield* fixToTypeImport(
                  fixer,
                  {
                    node: report.node,
                    typeSpecifiers: report.typeSpecifiers,
                    typeOnlyNamedImport: sourceImports.typeOnlyNamedImport,
                  },
                  sourceCode,
                );
              },
            });
          } else {
            // we have a mixed type/value import, so we need to split them out into multiple exports
            const typeImportNames: string[] = report.typeSpecifiers.map(
              specifier => `"${specifier.local.name}"`,
            );
            context.report({
              node: report.node,
              messageId:
                typeImportNames.length === 1
                  ? 'aImportIsOnlyTypes'
                  : 'someImportsAreOnlyTypes',
              data: {
                typeImports:
                  typeImportNames.length === 1
                    ? typeImportNames[0]
                    : [
                        typeImportNames.slice(0, -1).join(', '),
                        typeImportNames.slice(-1)[0],
                      ].join(' and '),
              },
              *fix(fixer) {
                yield* fixToTypeImport(
                  fixer,
                  {
                    node: report.node,
                    typeSpecifiers: report.typeSpecifiers,
                    typeOnlyNamedImport: sourceImports.typeOnlyNamedImport,
                  },
                  sourceCode,
                );
              },
            });
          }
        }
      }
    },
  };
}

/**
 * Create rule visitor for prefer 'no-type-imports'
 */
function createPreferNoTypeImportsVisitor(
  context: TSESLint.RuleContext<MessageIds, Options>,
): TSESLint.RuleListener {
  const sourceCode = context.getSourceCode();
  return {
    // prefer no type imports
    'ImportDeclaration[importKind = "type"]'(
      node: TSESTree.ImportDeclaration,
    ): void {
      context.report({
        node,
        messageId: 'valueOverType',
        fix(fixer) {
          return fixToValueImport(fixer, node);
        },
      });
    },
  };

  function fixToValueImport(
    fixer: TSESLint.RuleFixer,
    node: TSESTree.ImportDeclaration,
  ): TSESLint.RuleFix {
    // import type Foo from 'foo'
    //        ^^^^ remove
    const importToken = util.nullThrows(
      sourceCode.getFirstToken(node, isImportToken),
      util.NullThrowsReasons.MissingToken('import', node.type),
    );
    const typeToken = util.nullThrows(
      sourceCode.getFirstTokenBetween(
        importToken,
        node.specifiers[0]?.local ?? node.source,
        isTypeToken,
      ),
      util.NullThrowsReasons.MissingToken('type', node.type),
    );
    const afterToken = util.nullThrows(
      sourceCode.getTokenAfter(typeToken, { includeComments: true }),
      util.NullThrowsReasons.MissingToken('any token', node.type),
    );
    return fixer.removeRange([typeToken.range[0], afterToken.range[0]]);
  }
}

/**
 * Create rule visitor for prefer 'type-imports-combine'
 */
function createPreferTypeImportsCombineVisitor(
  context: TSESLint.RuleContext<MessageIds, Options>,
): TSESLint.RuleListener {
  interface SourceImports {
    source: string;
    list: {
      node: TSESTree.ImportDeclaration;
      numOfTypeSpecifiers: number;
      numOfValueSpecifiers: number;
      numOfUnusedSpecifiers: number;
      usedSpecifiers: UsedSpecifiers;
    }[];
    numOfTypeSpecifiers: number;
    numOfValueSpecifiers: number;
    numOfUnusedSpecifiers: number;
  }
  interface UsedSpecifiers {
    default: boolean; // import Def from 'mod'
    namespace: boolean; // import * as Ns from 'mod'
    named: boolean; // import { Named } from 'mod'
  }
  type SpecifierKey = keyof UsedSpecifiers;
  const SPECIFIER_KIND_DEF_IMPORT = 'default';
  const SPECIFIER_KIND_NS_IMPORT = 'namespace';
  const SPECIFIER_KIND_NAMED_IMPORT = 'named';
  const SPECIFIER_KEYS: SpecifierKey[] = [
    SPECIFIER_KIND_DEF_IMPORT,
    SPECIFIER_KIND_NS_IMPORT,
    SPECIFIER_KIND_NAMED_IMPORT,
  ];

  const sourceCode = context.getSourceCode();

  const sourceImportsMap: { [key: string]: SourceImports } = {};
  return {
    // prefer type imports
    ImportDeclaration(node: TSESTree.ImportDeclaration): void {
      if (!node.specifiers.length) {
        // ignore empty declaration
        return;
      }
      const source = node.source.value as string;
      const sourceImports = (sourceImportsMap[source] ??= {
        source,
        numOfTypeSpecifiers: 0,
        numOfValueSpecifiers: 0,
        numOfUnusedSpecifiers: 0,
        list: [],
      });

      const {
        typeSpecifiers,
        valueSpecifiers,
        unusedSpecifiers,
      } = parseUsedKindSpecifierVariables(context, node);

      const numOfTypeSpecifiers = typeSpecifiers.length;
      const numOfValueSpecifiers = valueSpecifiers.length;
      const numOfUnusedSpecifiers = unusedSpecifiers.length;

      sourceImports.numOfTypeSpecifiers += numOfTypeSpecifiers;
      sourceImports.numOfValueSpecifiers += numOfValueSpecifiers;
      sourceImports.numOfUnusedSpecifiers += numOfUnusedSpecifiers;

      sourceImports.list.push({
        node,
        numOfTypeSpecifiers,
        numOfValueSpecifiers,
        numOfUnusedSpecifiers,
        usedSpecifiers: {
          default: node.specifiers.some(isDefaultSpecifier),
          namespace: node.specifiers.some(isNamespaceSpecifier),
          named: node.specifiers.some(isNamedSpecifier),
        },
      });
    },
    'Program:exit'(): void {
      for (const {
        numOfValueSpecifiers,
        numOfUnusedSpecifiers,
        list,
      } of Object.values(sourceImportsMap).filter(
        ({ numOfTypeSpecifiers }) => numOfTypeSpecifiers > 0,
      )) {
        if (numOfValueSpecifiers === 0 && numOfUnusedSpecifiers === 0) {
          // All specifiers were used as types.

          const typeOnlyImportSpecifierKindMap: {
            [key in SpecifierKey]?: TSESTree.ImportDeclaration;
          } = {};
          for (const { node, usedSpecifiers } of list) {
            if (node.importKind === 'value') {
              // non type-only imports
              context.report({
                node: node,
                messageId: 'typeOverValue',
                *fix(fixer) {
                  const typeOnlyNamedImportData = list.find(
                    ({ usedSpecifiers }) =>
                      usedSpecifiers.named &&
                      !usedSpecifiers.default &&
                      !usedSpecifiers.namespace,
                  );
                  yield* fixToTypeImport(
                    fixer,
                    {
                      node: node,
                      typeSpecifiers: node.specifiers,
                      typeOnlyNamedImport:
                        typeOnlyNamedImportData?.node ?? null,
                    },
                    sourceCode,
                  );
                },
              });
            } else {
              const specifierKind = SPECIFIER_KEYS.find(
                k => usedSpecifiers[k],
              )!;
              const alreadyNode = typeOnlyImportSpecifierKindMap[specifierKind];
              if (alreadyNode) {
                // duplicate
                context.report({
                  node: node,
                  messageId: 'duplicateTypeImports',
                  *fix(fixer) {
                    if (specifierKind !== SPECIFIER_KIND_NAMED_IMPORT) {
                      return;
                    }
                    yield* fixCombinImports(
                      fixer,
                      {
                        node: node,
                        toNode: alreadyNode,
                      },
                      sourceCode,
                    );
                  },
                });
              }
              typeOnlyImportSpecifierKindMap[specifierKind] = node;
            }
          }
          continue;
        }

        if (numOfValueSpecifiers > 0 && list.length > 0) {
          // Specifiers are used in types and values, and there maybe are multiple imports from the same source.

          for (const { node, usedSpecifiers } of list.filter(
            ({ numOfTypeSpecifiers }) => numOfTypeSpecifiers > 0,
          )) {
            const targetValueImportData = list
              .filter(({ node }) => node.importKind === 'value')
              .find(({ node }): boolean => {
                for (const specifier of node.specifiers) {
                  if (usedSpecifiers.default) {
                    if (isDefaultSpecifier(specifier)) {
                      return false;
                    }
                  }
                  if (usedSpecifiers.namespace) {
                    if (
                      isNamespaceSpecifier(specifier) ||
                      isNamedSpecifier(specifier)
                    ) {
                      return false;
                    }
                  }
                  if (usedSpecifiers.named) {
                    if (isNamespaceSpecifier(specifier)) {
                      return false;
                    }
                  }
                }
                return true;
              });
            if (targetValueImportData) {
              // Must be the same statement as a non-type-only import.

              context.report({
                node: node,
                messageId: 'mustBeOneImport',
                *fix(fixer) {
                  yield* fixCombinImports(
                    fixer,
                    {
                      node: node,
                      toNode: targetValueImportData.node,
                    },
                    sourceCode,
                  );
                },
              });
            }
          }
        }
      }
    },
  };
}

function parseUsedKindSpecifierVariables(
  context: TSESLint.RuleContext<MessageIds, Options>,
  node: TSESTree.ImportDeclaration,
): {
  typeSpecifiers: TSESTree.ImportClause[];
  valueSpecifiers: TSESTree.ImportClause[];
  unusedSpecifiers: TSESTree.ImportClause[];
} {
  const typeSpecifiers: TSESTree.ImportClause[] = [];
  const valueSpecifiers: TSESTree.ImportClause[] = [];
  const unusedSpecifiers: TSESTree.ImportClause[] = [];
  for (const specifier of node.specifiers) {
    const [variable] = context.getDeclaredVariables(specifier);
    if (variable.references.length === 0) {
      unusedSpecifiers.push(specifier);
    } else {
      const onlyHasTypeReferences = variable.references.every(ref => {
        if (ref.isValueReference) {
          // `type T = typeof foo` will create a value reference because "foo" must be a value type
          // however this value reference is safe to use with type-only imports
          let parent = ref.identifier.parent;
          while (parent) {
            if (parent.type === AST_NODE_TYPES.TSTypeQuery) {
              return true;
            }
            // TSTypeQuery must have a TSESTree.EntityName as its child, so we can filter here and break early
            if (parent.type !== AST_NODE_TYPES.TSQualifiedName) {
              break;
            }
            parent = parent.parent;
          }
          return false;
        }

        return ref.isTypeReference;
      });
      if (onlyHasTypeReferences) {
        typeSpecifiers.push(specifier);
      } else {
        valueSpecifiers.push(specifier);
      }
    }
  }
  return {
    valueSpecifiers,
    typeSpecifiers,
    unusedSpecifiers,
  };
}

function* fixToTypeImport(
  fixer: TSESLint.RuleFixer,
  {
    node,
    typeSpecifiers,
    typeOnlyNamedImport,
  }: {
    node: TSESTree.ImportDeclaration;
    typeSpecifiers: TSESTree.ImportClause[];
    typeOnlyNamedImport: TSESTree.ImportDeclaration | null;
  },
  sourceCode: TSESLint.SourceCode,
): IterableIterator<TSESLint.RuleFix> {
  const defaultSpecifier: TSESTree.ImportDefaultSpecifier | null = isDefaultSpecifier(
    node.specifiers[0],
  )
    ? node.specifiers[0]
    : null;
  const namespaceSpecifier: TSESTree.ImportNamespaceSpecifier | null =
    node.specifiers.find(isNamespaceSpecifier) ?? null;
  const namedSpecifiers: TSESTree.ImportSpecifier[] = node.specifiers.filter(
    isNamedSpecifier,
  );

  if (namespaceSpecifier && !defaultSpecifier) {
    // e.g.
    // import * as types from 'foo'
    yield* fixToTypeImportByInsertType(fixer, node, false, sourceCode);
    return;
  } else if (defaultSpecifier) {
    if (
      typeSpecifiers.includes(defaultSpecifier) &&
      namedSpecifiers.length === 0 &&
      !namespaceSpecifier
    ) {
      // e.g.
      // import Type from 'foo'
      yield* fixToTypeImportByInsertType(fixer, node, true, sourceCode);
      return;
    }
  } else {
    if (
      namedSpecifiers.every(specifier => typeSpecifiers.includes(specifier)) &&
      !namespaceSpecifier
    ) {
      // e.g.
      // import {Type1, Type2} from 'foo'
      yield* fixToTypeImportByInsertType(fixer, node, false, sourceCode);
      return;
    }
  }

  const typeNamedSpecifiers = namedSpecifiers.filter(specifier =>
    typeSpecifiers.includes(specifier),
  );

  const fixesNamedSpecifiers = getFixesNamedSpecifiers(
    typeNamedSpecifiers,
    namedSpecifiers,
  );
  const afterFixes: TSESLint.RuleFix[] = [];
  if (typeNamedSpecifiers.length) {
    if (typeOnlyNamedImport) {
      const closingBraceToken = util.nullThrows(
        sourceCode.getFirstTokenBetween(
          sourceCode.getFirstToken(typeOnlyNamedImport)!,
          typeOnlyNamedImport.source,
          util.isClosingBraceToken,
        ),
        util.NullThrowsReasons.MissingToken('}', typeOnlyNamedImport.type),
      );
      let insertText = fixesNamedSpecifiers.typeNamedSpecifiersText;
      const before = sourceCode.getTokenBefore(closingBraceToken)!;
      if (!util.isCommaToken(before) && !util.isOpeningBraceToken(before)) {
        insertText = ',' + insertText;
      }
      // import type { Already, Type1, Type2 } from 'foo'
      //                       ^^^^^^^^^^^^^ insert
      const insertTypeNamedSpecifiers = fixer.insertTextBefore(
        closingBraceToken,
        insertText,
      );
      if (typeOnlyNamedImport.range[1] <= node.range[0]) {
        yield insertTypeNamedSpecifiers;
      } else {
        afterFixes.push(insertTypeNamedSpecifiers);
      }
    } else {
      yield fixer.insertTextBefore(
        node,
        `import type {${
          fixesNamedSpecifiers.typeNamedSpecifiersText
        }} from ${sourceCode.getText(node.source)};\n`,
      );
    }
  }

  const fixesRemoveTypeNamespaceSpecifier: TSESLint.RuleFix[] = [];
  if (namespaceSpecifier && typeSpecifiers.includes(namespaceSpecifier)) {
    // e.g.
    // import Foo, * as Type from 'foo'
    // import DefType, * as Type from 'foo'
    // import DefType, * as Type from 'foo'
    const commaToken = util.nullThrows(
      sourceCode.getTokenBefore(namespaceSpecifier, util.isCommaToken),
      util.NullThrowsReasons.MissingToken(',', node.type),
    );

    // import Def, * as Ns from 'foo'
    //           ^^^^^^^^^ remove
    fixesRemoveTypeNamespaceSpecifier.push(
      fixer.removeRange([commaToken.range[0], namespaceSpecifier.range[1]]),
    );

    // import type * as Ns from 'foo'
    // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ insert
    yield fixer.insertTextBefore(
      node,
      `import type ${sourceCode.getText(
        namespaceSpecifier,
      )} from ${sourceCode.getText(node.source)};\n`,
    );
  }
  if (defaultSpecifier && typeSpecifiers.includes(defaultSpecifier)) {
    if (typeSpecifiers.length === node.specifiers.length) {
      const importToken = util.nullThrows(
        sourceCode.getFirstToken(node, isImportToken),
        util.NullThrowsReasons.MissingToken('import', node.type),
      );
      // import type Type from 'foo'
      //        ^^^^ insert
      yield fixer.insertTextAfter(importToken, ' type');
    } else {
      const commaToken = util.nullThrows(
        sourceCode.getTokenAfter(defaultSpecifier, util.isCommaToken),
        util.NullThrowsReasons.MissingToken(',', defaultSpecifier.type),
      );
      // import Type , {...} from 'foo'
      //        ^^^^^ pick
      const defaultText = sourceCode.text
        .slice(defaultSpecifier.range[0], commaToken.range[0])
        .trim();
      yield fixer.insertTextBefore(
        node,
        `import type ${defaultText} from ${sourceCode.getText(node.source)};\n`,
      );
      const afterToken = util.nullThrows(
        sourceCode.getTokenAfter(commaToken, { includeComments: true }),
        util.NullThrowsReasons.MissingToken('any token', node.type),
      );
      // import Type , {...} from 'foo'
      //        ^^^^^^^ remove
      yield fixer.removeRange([defaultSpecifier.range[0], afterToken.range[0]]);
    }
  }

  yield* fixesNamedSpecifiers.removeTypeNamedSpecifiers;
  yield* fixesRemoveTypeNamespaceSpecifier;

  yield* afterFixes;

  /**
   * Returns information for fixing named specifiers.
   */
  function getFixesNamedSpecifiers(
    typeNamedSpecifiers: TSESTree.ImportSpecifier[],
    allNamedSpecifiers: TSESTree.ImportSpecifier[],
  ): {
    typeNamedSpecifiersText: string;
    removeTypeNamedSpecifiers: TSESLint.RuleFix[];
  } {
    if (allNamedSpecifiers.length === 0) {
      return {
        typeNamedSpecifiersText: '',
        removeTypeNamedSpecifiers: [],
      };
    }
    const typeNamedSpecifiersTexts: string[] = [];
    const removeTypeNamedSpecifiers: TSESLint.RuleFix[] = [];
    if (typeNamedSpecifiers.length === allNamedSpecifiers.length) {
      // e.g.
      // import Foo, {Type1, Type2} from 'foo'
      // import DefType, {Type1, Type2} from 'foo'
      const openingBraceToken = util.nullThrows(
        sourceCode.getTokenBefore(
          typeNamedSpecifiers[0],
          util.isOpeningBraceToken,
        ),
        util.NullThrowsReasons.MissingToken('{', node.type),
      );
      const commaToken = util.nullThrows(
        sourceCode.getTokenBefore(openingBraceToken, util.isCommaToken),
        util.NullThrowsReasons.MissingToken(',', node.type),
      );
      const closingBraceToken = util.nullThrows(
        sourceCode.getFirstTokenBetween(
          openingBraceToken,
          node.source,
          util.isClosingBraceToken,
        ),
        util.NullThrowsReasons.MissingToken('}', node.type),
      );

      // import DefType, {...} from 'foo'
      //               ^^^^^^^ remove
      removeTypeNamedSpecifiers.push(
        fixer.removeRange([commaToken.range[0], closingBraceToken.range[1]]),
      );

      typeNamedSpecifiersTexts.push(
        sourceCode.text.slice(
          openingBraceToken.range[1],
          closingBraceToken.range[0],
        ),
      );
    } else {
      const typeNamedSpecifierGroups: TSESTree.ImportSpecifier[][] = [];
      let group: TSESTree.ImportSpecifier[] = [];
      for (const namedSpecifier of allNamedSpecifiers) {
        if (typeNamedSpecifiers.includes(namedSpecifier)) {
          group.push(namedSpecifier);
        } else if (group.length) {
          typeNamedSpecifierGroups.push(group);
          group = [];
        }
      }
      if (group.length) {
        typeNamedSpecifierGroups.push(group);
      }
      for (const namedSpecifiers of typeNamedSpecifierGroups) {
        const { removeRange, textRange } = getNamedSpecifierRanges(
          namedSpecifiers,
          allNamedSpecifiers,
        );
        removeTypeNamedSpecifiers.push(fixer.removeRange(removeRange));

        typeNamedSpecifiersTexts.push(sourceCode.text.slice(...textRange));
      }
    }
    return {
      typeNamedSpecifiersText: typeNamedSpecifiersTexts.join(','),
      removeTypeNamedSpecifiers,
    };
  }

  /**
   * Returns ranges for fixing named specifier.
   */
  function getNamedSpecifierRanges(
    namedSpecifierGroup: TSESTree.ImportSpecifier[],
    allNamedSpecifiers: TSESTree.ImportSpecifier[],
  ): {
    textRange: TSESTree.Range;
    removeRange: TSESTree.Range;
  } {
    const first = namedSpecifierGroup[0];
    const last = namedSpecifierGroup[namedSpecifierGroup.length - 1];
    const removeRange: TSESTree.Range = [first.range[0], last.range[1]];
    const textRange: TSESTree.Range = [...removeRange];
    const before = sourceCode.getTokenBefore(first)!;
    textRange[0] = before.range[1];
    if (util.isCommaToken(before)) {
      removeRange[0] = before.range[0];
    } else {
      removeRange[0] = before.range[1];
    }

    const isFirst = allNamedSpecifiers[0] === first;
    const isLast = allNamedSpecifiers[allNamedSpecifiers.length - 1] === last;
    const after = sourceCode.getTokenAfter(last)!;
    textRange[1] = after.range[0];
    if (isFirst || isLast) {
      if (util.isCommaToken(after)) {
        removeRange[1] = after.range[1];
      }
    }

    return {
      textRange,
      removeRange,
    };
  }
}

function* fixToTypeImportByInsertType(
  fixer: TSESLint.RuleFixer,
  node: TSESTree.ImportDeclaration,
  isDefaultImport: boolean,
  sourceCode: TSESLint.SourceCode,
): IterableIterator<TSESLint.RuleFix> {
  // import type Foo from 'foo'
  //       ^^^^^ insert
  const importToken = util.nullThrows(
    sourceCode.getFirstToken(node, isImportToken),
    util.NullThrowsReasons.MissingToken('import', node.type),
  );
  yield fixer.insertTextAfter(importToken, ' type');

  if (isDefaultImport) {
    // Has default import
    const openingBraceToken = sourceCode.getFirstTokenBetween(
      importToken,
      node.source,
      util.isOpeningBraceToken,
    );
    if (openingBraceToken) {
      // Only braces. e.g. import Foo, {} from 'foo'
      const commaToken = util.nullThrows(
        sourceCode.getTokenBefore(openingBraceToken, util.isCommaToken),
        util.NullThrowsReasons.MissingToken(',', node.type),
      );
      const closingBraceToken = util.nullThrows(
        sourceCode.getFirstTokenBetween(
          openingBraceToken,
          node.source,
          util.isClosingBraceToken,
        ),
        util.NullThrowsReasons.MissingToken('}', node.type),
      );

      // import type Foo, {} from 'foo'
      //                  ^^ remove
      yield fixer.removeRange([
        commaToken.range[0],
        closingBraceToken.range[1],
      ]);
      const specifiersText = sourceCode.text.slice(
        commaToken.range[1],
        closingBraceToken.range[1],
      );
      if (node.specifiers.length > 1) {
        // import type Foo from 'foo'
        // import type {...} from 'foo' // <- insert
        yield fixer.insertTextAfter(
          node,
          `\nimport type${specifiersText} from ${sourceCode.getText(
            node.source,
          )};`,
        );
      }
    }
  }
}

function* fixCombinImports(
  fixer: TSESLint.RuleFixer,
  {
    node,
    toNode,
  }: {
    node: TSESTree.ImportDeclaration;
    toNode: TSESTree.ImportDeclaration;
  },
  sourceCode: TSESLint.SourceCode,
): IterableIterator<TSESLint.RuleFix> {
  const defaultSpecifier: TSESTree.ImportDefaultSpecifier | null = isDefaultSpecifier(
    node.specifiers[0],
  )
    ? node.specifiers[0]
    : null;
  const namespaceSpecifier: TSESTree.ImportNamespaceSpecifier | null =
    node.specifiers.find(isNamespaceSpecifier) ?? null;
  const namedSpecifiers: TSESTree.ImportSpecifier[] = node.specifiers.filter(
    isNamedSpecifier,
  );

  if (defaultSpecifier) {
    const importOrTypeToken = util.nullThrows(
      sourceCode.getTokenBefore(defaultSpecifier),
      util.NullThrowsReasons.MissingToken('import', node.type),
    );
    const afterToken = util.nullThrows(
      sourceCode.getTokenAfter(defaultSpecifier),
      util.NullThrowsReasons.MissingToken('from', node.type),
    );
    const defaultText = sourceCode.text
      .slice(importOrTypeToken.range[1], afterToken.range[0])
      .trim();

    const toImportToken = util.nullThrows(
      sourceCode.getFirstToken(toNode, isImportToken),
      util.NullThrowsReasons.MissingToken('import', toNode.type),
    );
    const insertTarget =
      toNode.importKind === 'type'
        ? util.nullThrows(
            sourceCode.getFirstTokenBetween(
              toImportToken,
              toNode.specifiers[0]?.local ?? toNode.source,
              isTypeToken,
            ),
            util.NullThrowsReasons.MissingToken('type', toNode.type),
          )
        : toImportToken;
    // import Foo, {...} from 'foo'
    //       ^^^^^ insert
    yield fixer.insertTextAfter(insertTarget, ` ${defaultText},`);
  }
  if (namespaceSpecifier) {
    const beforeToken = util.nullThrows(
      sourceCode.getTokenBefore(namespaceSpecifier),
      util.NullThrowsReasons.MissingToken('import', node.type),
    );
    const afterToken = util.nullThrows(
      sourceCode.getTokenAfter(namespaceSpecifier),
      util.NullThrowsReasons.MissingToken('from', node.type),
    );
    const namespaceText = sourceCode.text
      .slice(beforeToken.range[1], afterToken.range[0])
      .trim();

    const toDefaultSpecifier = toNode.specifiers.find(isDefaultSpecifier);
    if (!toDefaultSpecifier) {
      // It should exist.
      return;
    }

    // import Def, * as Foo from 'foo'
    //           ^^^^^^^^^^ insert
    yield fixer.insertTextAfter(toDefaultSpecifier, `, ${namespaceText}`);
  }
  if (namedSpecifiers.length) {
    const openingBraceToken = util.nullThrows(
      sourceCode.getTokenBefore(namedSpecifiers[0], util.isOpeningBraceToken),
      util.NullThrowsReasons.MissingToken('{', node.type),
    );
    const closingBraceToken = util.nullThrows(
      sourceCode.getFirstTokenBetween(
        namedSpecifiers[namedSpecifiers.length - 1],
        node.source,
        token => util.isClosingBraceToken(token) || util.isCommaToken(token),
      ),
      util.NullThrowsReasons.MissingToken('}', node.type),
    );

    const specifiersText = sourceCode.text.slice(
      openingBraceToken.range[1],
      closingBraceToken.range[0],
    );

    const toClosingBraceToken =sourceCode.getFirstTokenBetween(toNode.specifiers[toNode.specifiers.length-1], toNode.source,util.isClosingBraceToken);
    if (toClosingBraceToken) {
      const beforeToken = sourceCode.getTokenBefore(toClosingBraceToken)!;
      const insertTarget = util.isCommaToken(beforeToken) ? beforeToken : toClosingBraceToken
      if (toNode.specifiers.some(isNamedSpecifier)) {
      // import {A, B, Move1, Move2} from 'foo'
      //             ^^^^^^^^^^^^^^ insert
      yield fixer.insertTextBefore(
        insertTarget,
        `,${specifiersText.trim()}`,
      );
      } else {
      // import { Move1, Move2 } from 'foo'
      //         ^^^^^^^^^^^^^^ insert
      yield fixer.insertTextBefore(
        insertTarget,
        ` ${specifiersText.trim()} `,
      );
      }
    } else {
      const fromToken = util.nullThrows(
        sourceCode.getTokenBefore(toNode.source),
        util.NullThrowsReasons.MissingToken('from', node.type),
      );

      // import D, {Move1, Move2} from 'foo'
      //         ^^^^^^^^^^^^^^^^^ insert
      yield fixer.replaceTextRange(
        [
          sourceCode.getTokenBefore(fromToken, { includeComments: true })!
            .range[1],
          fromToken.range[0],
        ],
        `, {${specifiersText}} `,
      );
    }
  }

  yield fixer.remove(node);
}
