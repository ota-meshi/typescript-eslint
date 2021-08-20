import rule from '../../src/rules/valid-rule-meta';
import { RuleTester } from '../RuleTester';

const ruleTester = new RuleTester({
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
  },
});

ruleTester.run('valid-rule-meta', rule, {
  valid: [
    `
      export default createRule({
        meta: {},
        create(context) {
          return {
            Program(node) {
              context.report({ node, messageId: 'test' });
            },
          };
        },
      });
    `,
    `
      export default createRule({
        meta: {
          fixable: 'code',
        },
        create(context) {
          return {
            Program(node) {
              context.report({ node, messageId: 'test', fix() {} });
            },
          };
        },
      });
    `,
    `
      export default createRule({
        meta: {
          hasSuggestions: true,
        },
        create(context) {
          return {
            Program(node) {
              context.report({ node, messageId: 'test', suggest: [] });
            },
          };
        },
      });
    `,
    `
      export default createRule({
        meta: {
          fixable: 'code',
          hasSuggestions: true,
        },
        create(context) {
          return {
            Program(node) {
              context.report({ node, messageId: 'test', ...reportObject });
            },
          };
        },
      });
    `,
    `
      export default createRule({
        meta: {
          fixable: 'code',
          hasSuggestions: true,
        },
        create(context) {
          return {
            Program(node) {
              rule.Program(node);
            },
          };
        },
      });
    `,
    `
      export default createRule({
        meta: {
          ...ruleMeta,
        },
        create(context) {
          return {
            Program(node) {
              context.report({ node, messageId: 'test', fix() {}, suggest: [] });
            },
          };
        },
      });
    `,
  ],
  invalid: [
    {
      code: `
        export default createRule({
          meta: {},
          create(context) {
            return {
              Program(node) {
                context.report({ node, messageId: 'test', fix() {} });
              },
            };
          },
        });
      `,
      errors: [
        {
          messageId: 'shouldBeFixable',
          line: 7,
        },
      ],
    },
    {
      code: `
        export default createRule({
          meta: {
            fixable: 'code',
          },
          create(context) {
            return {
              Program(node) {
                context.report({ node, messageId: 'test' });
              },
            };
          },
        });
      `,
      errors: [
        {
          messageId: 'shouldNotBeFixable',
          line: 4,
        },
      ],
    },
    {
      code: `
        export default createRule({
          meta: {},
          create(context) {
            return {
              Program(node) {
                context.report({ node, messageId: 'test', suggest: [] });
              },
            };
          },
        });
      `,
      errors: [
        {
          messageId: 'shouldBeSuggestable',
          line: 7,
        },
      ],
    },
    {
      code: `
        export default createRule({
          meta: {
            hasSuggestions: true,
          },
          create(context) {
            return {
              Program(node) {
                context.report({ node, messageId: 'test' });
              },
            };
          },
        });
      `,
      errors: [
        {
          messageId: 'shouldNotBeSuggestable',
          line: 4,
        },
      ],
    },
  ],
});
