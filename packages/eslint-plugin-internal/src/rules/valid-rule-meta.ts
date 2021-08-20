import {
  AST_NODE_TYPES,
  TSESTree,
  ASTUtils,
} from '@typescript-eslint/experimental-utils';
import { createRule } from '../util';

export default createRule({
  name: __filename,
  meta: {
    type: 'problem',
    docs: {
      category: 'Best Practices',
      recommended: 'error',
      description:
        'Ensures consistent usage of AST_NODE_TYPES & AST_TOKEN_TYPES enums.',
    },
    messages: {
      shouldBeFixable:
        '`meta.fixable` must be either `"code"` or `"whitespace"` for fixable rules.',
      shouldNotBeFixable:
        '`meta.fixable` cannot set a value for non-fixable rules.',
      shouldBeSuggestable:
        '`meta.hasSuggestions` must be `true` for suggestable rules.',
      shouldNotBeSuggestable:
        '`meta.hasSuggestions` cannot be `true` for non-suggestable rules.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function reports(
      nodes: TSESTree.Property['key'][],
      messageId:
        | 'shouldBeFixable'
        | 'shouldNotBeFixable'
        | 'shouldBeSuggestable'
        | 'shouldNotBeSuggestable',
    ): void {
      for (const node of nodes) {
        context.report({
          node: node,
          messageId: messageId,
        });
      }
    }

    function* iterateProperties(
      node: TSESTree.ObjectExpression,
    ): Iterable<TSESTree.ObjectLiteralElement> {
      for (const prop of node.properties) {
        if (
          prop.type === AST_NODE_TYPES.Property ||
          prop.type === AST_NODE_TYPES.MethodDefinition
        ) {
          yield prop;
          continue;
        }

        const argument = prop.argument;
        let hasUnknown = false;
        for (const expr of flattenExpressions(argument)) {
          if (expr.type === AST_NODE_TYPES.ObjectExpression) {
            yield* iterateProperties(expr);
            continue;
          }
          hasUnknown = true;
        }
        if (hasUnknown) {
          yield prop;
        }
      }
    }
    function* flattenExpressions(
      node: TSESTree.Expression,
    ): Iterable<TSESTree.Expression> {
      if (node.type === AST_NODE_TYPES.Identifier) {
        const variable = ASTUtils.findVariable(context.getScope(), node);
        if (
          variable &&
          variable.defs.length === 1 &&
          variable.defs[0].type === 'Variable' &&
          variable.defs[0].parent.kind === 'const' &&
          variable.defs[0].node.init
        ) {
          const init = variable.defs[0].node.init;
          yield* flattenExpressions(init);
          return;
        }
      } else if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        yield* flattenExpressions(node.consequent);
        yield* flattenExpressions(node.alternate);
        return;
      }
      yield node;
    }
    let ruleObject: {
      meta: TSESTree.ObjectExpression;
      context: TSESTree.Identifier;
      report: {
        suggestNodes: TSESTree.Property['key'][];
        fixNodes: TSESTree.Property['key'][];
        hasUnknown: boolean;
        found: boolean;
      };
    } | null = null;
    return {
      ObjectExpression(node): void {
        if (ruleObject) {
          return;
        }
        let meta: TSESTree.Property | null = null;
        let create: TSESTree.Property | null = null;
        for (const prop of node.properties) {
          if (prop.type !== AST_NODE_TYPES.Property) {
            continue;
          }
          const name = ASTUtils.getPropertyName(prop);
          if (name === 'meta') {
            meta = prop;
          } else if (name === 'create') {
            create = prop;
          }
        }
        if (
          !meta ||
          !create ||
          meta.value.type !== AST_NODE_TYPES.ObjectExpression ||
          (create.value.type !== AST_NODE_TYPES.FunctionExpression &&
            create.value.type !== AST_NODE_TYPES.ArrowFunctionExpression) ||
          create.value.params.length < 1
        ) {
          return;
        }
        const context = create.value.params[0];
        if (!context || context.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        ruleObject = {
          meta: meta.value,
          context,
          report: {
            suggestNodes: [],
            fixNodes: [],
            hasUnknown: false,
            found: false,
          },
        };
      },
      CallExpression(node): void {
        if (
          !ruleObject ||
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.object.type !== AST_NODE_TYPES.Identifier ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier ||
          node.callee.property.name !== 'report' ||
          node.arguments.length !== 1
        ) {
          return;
        }
        const variable = ASTUtils.findVariable(
          context.getScope(),
          node.callee.object,
        );
        if (
          !variable ||
          !variable.defs.some(def => def.name === ruleObject?.context)
        ) {
          return;
        }
        ruleObject.report.found = true;
        if (node.arguments[0].type !== AST_NODE_TYPES.ObjectExpression) {
          ruleObject.report.hasUnknown = true;
          return;
        }
        const descriptor = node.arguments[0];
        for (const prop of iterateProperties(descriptor)) {
          if (prop.type !== AST_NODE_TYPES.Property) {
            ruleObject.report.hasUnknown = true;
            continue;
          }
          const name = ASTUtils.getPropertyName(prop);
          if (name === 'suggest') {
            ruleObject.report.suggestNodes.push(prop.key);
          } else if (name === 'fix') {
            ruleObject.report.fixNodes.push(prop.key);
          }
        }
      },
      'Program:exit'(): void {
        if (!ruleObject) {
          return;
        }
        if (!ruleObject.report.found) {
          return;
        }
        const meta = ruleObject.meta;
        let fixableProp: TSESTree.Property | null = null;
        let hasSuggestionsProp: TSESTree.Property | null = null;
        let hasSpread = false;
        for (const prop of iterateProperties(meta)) {
          if (prop.type === AST_NODE_TYPES.SpreadElement) {
            hasSpread = true;
            continue;
          }
          if (prop.type !== AST_NODE_TYPES.Property) {
            continue;
          }
          const name = ASTUtils.getPropertyName(prop);
          if (name === 'fixable') {
            fixableProp = prop;
          } else if (name === 'hasSuggestions') {
            hasSuggestionsProp = prop;
          }
        }

        if (ruleObject.report.fixNodes.length) {
          if (hasSpread) {
            // maybe ok
          } else if (!fixableProp) {
            reports(ruleObject.report.fixNodes, 'shouldBeFixable');
          } else {
            if (
              (fixableProp.value.type === AST_NODE_TYPES.Literal &&
                fixableProp.value.value === null) ||
              (fixableProp.value.type === AST_NODE_TYPES.Identifier &&
                fixableProp.value.name === 'undefined')
            ) {
              reports(ruleObject.report.fixNodes, 'shouldBeFixable');
            }
          }
        } else if (!ruleObject.report.hasUnknown) {
          if (
            fixableProp &&
            fixableProp.value.type === AST_NODE_TYPES.Literal &&
            typeof fixableProp.value.value === 'string'
          ) {
            context.report({
              node: fixableProp,
              messageId: 'shouldNotBeFixable',
            });
          }
        }
        if (ruleObject.report.suggestNodes.length) {
          if (hasSpread) {
            // maybe ok
          } else if (!hasSuggestionsProp) {
            reports(ruleObject.report.suggestNodes, 'shouldBeSuggestable');
          } else {
            if (
              hasSuggestionsProp.value.type === AST_NODE_TYPES.Literal &&
              hasSuggestionsProp.value.value !== true
            ) {
              reports(ruleObject.report.suggestNodes, 'shouldBeSuggestable');
            }
          }
        } else if (!ruleObject.report.hasUnknown) {
          if (
            hasSuggestionsProp &&
            hasSuggestionsProp.value.type === AST_NODE_TYPES.Literal &&
            hasSuggestionsProp.value.value === true
          ) {
            context.report({
              node: hasSuggestionsProp,
              messageId: 'shouldNotBeSuggestable',
            });
          }
        }
      },
    };
  },
});
