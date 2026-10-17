// Exercise component state with real React; only the native rendering boundary is mocked.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { window } = new JSDOM('<html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
export const { act } = React;
export const wrap = ({ children }) => React.createElement('div', null, children);
export const native = { View: wrap, Pressable: wrap, Switch: wrap, Modal: wrap, StyleSheet: { create: value => value, absoluteFill: {}, hairlineWidth: 1 } };
export const theme = { Colors: {}, Layout: {}, Radius: {}, Spacing: {}, Shadow: {} };
export const ui = {
 AppText: wrap, Icon: wrap,
 Button: props => React.createElement('button', { onClick: props.onPress, disabled: props.disabled || props.loading }, props.label),
 Chip: props => React.createElement('button', { onClick: props.onPress, disabled: props.disabled, 'data-selected': !!props.selected }, props.label),
 IconButton: props => React.createElement('button', { onClick: props.onPress, disabled: props.disabled, 'aria-label': props.accessibilityLabel }, props.icon),
};
export function load(file, mocks = {}) {
 const url = new URL('../../src/' + file, import.meta.url);
 const source = fs.readFileSync(url, 'utf8');
 const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
 const module = { exports: {} };
 vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: file })(name => name in mocks ? mocks[name] : require(name), module, module.exports);
 return module.exports;
}
export function deferred() {
 let resolve, reject;
 const promise = new Promise((a, b) => { resolve = a; reject = b; });
 return { promise, resolve, reject };
}
export function mount(Component, props) {
 const container = document.createElement('div'); document.body.append(container);
 const root = createRoot(container);
 return { container, render: next => act(() => root.render(React.createElement(Component, next ?? props))), close: async () => { await act(() => root.unmount()); container.remove(); } };
}
export function button(container, label) {
 const result = [...container.querySelectorAll('button')].find(item => item.textContent === label);
 if (!result) throw new Error('Missing button: ' + label);
 return result;
}
