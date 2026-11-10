// Value-safety engine for the escape (X1) and CSS-injection (X2) guards. Adapted from the classifier in
// Jellyfin Canopy's src/test/escape-guard.test.ts (GPL-3.0); syntax only, no type checker.
//
// unsafeLeaves(expr) returns the atomic sub-expressions of `expr` that are not recognisably safe, at their own
// source positions (so a value built in one place and interpolated in another is reported where it is built).
// An empty list means the expression is safe. The guard fails closed: anything it cannot prove is a leaf.
//
// What counts as safe (both guards):
//   - literals, numbers, booleans, arithmetic and comparison results, typeof/!/+x;
//   - UPPER_CASE constants (plugin-owned tables and markup) and `.length`/`.size`;
//   - numeric and date producers (Number(), parseInt(), Math.*, toFixed(), toLocaleDateString(), …);
//   - the guard's own escapers / validators (vocab.safeCalls), and `isX(v) ? v : …` validator ternaries;
//   - local values: a const/let is as safe as its initializer and every later assignment (and `.push()` for
//     arrays that are joined); a call to a function in client/src is as safe as everything it returns;
//   - a function parameter is safe by caller contract when the function is only ever called (never passed
//     around) and every call site, in its file or through a named import, passes a safe argument;
//   - `.map(cb).join()` is as safe as what `cb` returns; a callback over a constant array gets safe elements;
//   - the default import of a client/src `.css` file (its text, inlined by the build's `text` loader).
import { posix } from 'node:path';
import {
  assignedValues, calleeName, functionOf, importedReferences, isExported, lastName, propertyName, receiverOf,
  references, resolve, resolveImport, returnedExpressions, rootIdentifier, ts, unwrap,
} from './lib.mjs';

const UPPER_CONST = /^[A-Z][A-Z0-9_]+$/;
const SAFE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
const NUMERIC_CALLS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean', 'isNaN', 'isFinite']);
const NUMERIC_NAMESPACES = new Set(['Math', 'Number', 'Date', 'Array', 'Object.is']);
const NUMERIC_METHODS = new Set([
  'toFixed', 'toPrecision', 'indexOf', 'lastIndexOf', 'findIndex', 'findLastIndex', 'charCodeAt', 'codePointAt',
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getMilliseconds', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCHours', 'getUTCMinutes', 'getTimezoneOffset',
  'includes', 'has', 'some', 'every', 'startsWith', 'endsWith', 'test', 'localeCompare', 'isArray', 'contains', 'matches',
  'toLocaleDateString', 'toLocaleTimeString', 'toISOString', 'toUTCString', 'toDateString', 'toTimeString',
  'toLocaleString', 'now', 'round', 'floor', 'ceil', 'abs', 'min', 'max', 'trunc', 'sign',
]);
/** Methods whose result is as safe as their receiver (and listed arguments). */
const STRING_METHODS = new Set([
  'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase',
  'slice', 'substring', 'substr', 'padStart', 'padEnd', 'repeat', 'normalize', 'charAt', 'at', 'toString',
  'concat', 'replace', 'replaceAll', 'split',
]);
const ARRAY_PASSTHROUGH = new Set(['filter', 'slice', 'sort', 'reverse', 'flat', 'concat', 'toSorted', 'toReversed']);
const ELEMENT_CALLBACKS = new Set(['map', 'forEach', 'flatMap', 'filter', 'find', 'findLast', 'some', 'every']);
const READ_BACK_MARKUP = new Set(['innerHTML', 'outerHTML']);

/**
 * @param {object} project from createProject()
 * @param {{ safeCalls: (call, name) => boolean, validators: (name) => boolean, translations: Set<string>,
 *   checkedElsewhere?: (node) => boolean }} vocab
 */
export function createChecker(project, vocab) {
  const memo = new Map();
  const paramMemo = new Map();
  const elementMemo = new Map();

  function leaves(expression) {
    const e = unwrap(expression);
    if (!e) return [];
    if (memo.has(e)) return memo.get(e) ?? [];
    memo.set(e, null);   // in progress: assume safe (coinductive), so cycles terminate
    const result = compute(e);
    memo.set(e, result);
    return result;
  }

  const all = list => list.flatMap(x => leaves(x));

  function compute(e) {
    if (vocab.checkedElsewhere?.(e)) return [];
    switch (e.kind) {
      case ts.SyntaxKind.StringLiteral: case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.NumericLiteral: case ts.SyntaxKind.BigIntLiteral: case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword: case ts.SyntaxKind.NullKeyword: case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.PrefixUnaryExpression: case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.TypeOfExpression: case ts.SyntaxKind.VoidExpression: case ts.SyntaxKind.DeleteExpression:
      case ts.SyntaxKind.ArrowFunction: case ts.SyntaxKind.FunctionExpression: case ts.SyntaxKind.ObjectLiteralExpression:
        return [];
      case ts.SyntaxKind.TemplateExpression: return all(e.templateSpans.map(s => s.expression));
      case ts.SyntaxKind.ArrayLiteralExpression: return elementLeaves(e);
      case ts.SyntaxKind.Identifier: return identifierLeaves(e);
      case ts.SyntaxKind.ConditionalExpression: return conditionalLeaves(e);
      case ts.SyntaxKind.BinaryExpression: return binaryLeaves(e);
      case ts.SyntaxKind.CallExpression: return callLeaves(e);
      case ts.SyntaxKind.PropertyAccessExpression: case ts.SyntaxKind.ElementAccessExpression: return accessLeaves(e);
      default: return [e];
    }
  }

  function binaryLeaves(e) {
    const op = e.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.PlusToken: case ts.SyntaxKind.BarBarToken: case ts.SyntaxKind.QuestionQuestionToken:
        return [...leaves(e.left), ...leaves(e.right)];
      case ts.SyntaxKind.AmpersandAmpersandToken: case ts.SyntaxKind.CommaToken:
        return leaves(e.right);
      default:
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return leaves(e.right);
        return [];   // arithmetic, comparison, bitwise, instanceof, in: numbers and booleans
    }
  }

  /** `isValid(x) ? …x… : y`: the validated text is safe in the true branch. */
  function conditionalLeaves(e) {
    const validated = new Set();
    (function collect(c) {
      c = unwrap(c);
      if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { collect(c.left); collect(c.right); return; }
      if (ts.isCallExpression(c) && vocab.validators(calleeName(c) ?? '') && c.arguments[0]) validated.add(unwrap(c.arguments[0]).getText());
    })(e.condition);
    const whenTrue = unwrap(e.whenTrue);
    const trueLeaves = validated.has(whenTrue.getText()) ? [] : leaves(e.whenTrue);
    return [...trueLeaves, ...leaves(e.whenFalse)];
  }

  function identifierLeaves(id) {
    if (SAFE_GLOBALS.has(id.text) || UPPER_CONST.test(id.text)) return [];
    let binding = resolve(id);
    if (!binding) return [id];
    if (cssTextImport(binding.decl)) return [];
    if (ts.isImportSpecifier(binding.decl)) {
      binding = resolveImport(project, binding);
      if (!binding) return [id];
    }
    const decl = binding.decl;
    if (ts.isParameter(decl)) return parameterSafe(decl) ? [] : [id];
    if (ts.isBindingElement(decl)) return bindingElementSafe(decl) ? [] : [id];
    if (ts.isVariableDeclaration(decl)) {
      const holder = decl.parent.parent;
      if (ts.isForOfStatement(holder)) return elementLeaves(holder.expression).length ? [id] : [];
      if (ts.isForInStatement(holder)) return [id];
      if (ts.isCatchClause(decl.parent)) return [id];
      return [...(decl.initializer ? leaves(decl.initializer) : []), ...all(assignedValues(binding))];
    }
    return [id];
  }

  /**
   * The default import of a relative `.css` file under client/src is that file's text, inlined at build time as a
   * string literal (frontend.md §3 D1, the esbuild `text` loader). It is as constant as a template literal without
   * substitutions, which is what D2 moved into these files.
   */
  function cssTextImport(decl) {
    if (!ts.isImportClause(decl) || !decl.name || decl.isTypeOnly) return false;
    const specifier = decl.parent.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.') || !specifier.text.endsWith('.css')) return false;
    const target = posix.normalize(posix.join(posix.dirname(decl.getSourceFile().fileName), specifier.text));
    return target.startsWith('client/src/') && (project.synthetic || project.read(target) !== null);
  }

  /** A destructured name is safe when what it is destructured from is constant data. */
  function bindingElementSafe(element) {
    let p = element.parent;
    while (p && !ts.isVariableDeclaration(p) && !ts.isParameter(p)) p = p.parent;
    if (!p) return false;
    if (ts.isParameter(p)) return callbackOverConstant(p);
    return Boolean(p.initializer) && isConstantData(p.initializer);
  }

  function callLeaves(call) {
    const name = calleeName(call);
    const receiver = receiverOf(call);
    if (name && (vocab.safeCalls(call, name) || vocab.producers?.has(name))) return [];
    if (name && !receiver && NUMERIC_CALLS.has(name)) return [];
    if (name && receiver && ts.isIdentifier(receiver) && NUMERIC_NAMESPACES.has(receiver.text)
      && !['from', 'keys', 'values', 'entries', 'assign', 'fromEntries'].includes(name)) return [];
    if (name && receiver && NUMERIC_METHODS.has(name)) return [];
    if (name === 'String' && !receiver) return all(call.arguments);
    if (name && receiver && STRING_METHODS.has(name)) {
      if (name === 'replace' || name === 'replaceAll') {
        const replacement = call.arguments[1] && unwrap(call.arguments[1]);
        if (replacement && (ts.isArrowFunction(replacement) || ts.isFunctionExpression(replacement))) return [...leaves(receiver), ...returnLeaves(replacement)];
        return [...leaves(receiver), ...(replacement ? leaves(replacement) : [])];
      }
      if (name === 'concat' || name === 'padStart' || name === 'padEnd') return [...leaves(receiver), ...all(call.arguments)];
      return leaves(receiver);
    }
    if (name === 'join' && receiver) return [...elementLeaves(receiver), ...all(call.arguments)];
    if ((name === 'map' || name === 'flatMap') && receiver) return callbackLeaves(call.arguments[0]);
    if (name && receiver && ARRAY_PASSTHROUGH.has(name)) return elementLeaves(call);
    // A call to a function in client/src: as safe as everything it returns.
    const fn = calledFunction(call);
    if (fn) return returnLeaves(fn);
    if (name && vocab.translations.has(name)) return call.arguments.flatMap(argumentLeaves);
    return [call];
  }

  /** Translation params: every property value of an object literal argument must be safe. */
  function argumentLeaves(arg) {
    const a = unwrap(arg);
    if (ts.isObjectLiteralExpression(a)) {
      return a.properties.flatMap(p => ts.isPropertyAssignment(p) ? leaves(p.initializer)
        : ts.isShorthandPropertyAssignment(p) ? leaves(p.name) : ts.isSpreadAssignment(p) ? [p] : []);
    }
    return leaves(a);
  }

  /** The client/src function a call invokes (a local or imported function declaration or const arrow). */
  function calledFunction(call) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return null;
    let binding = resolve(callee);
    if (binding && ts.isImportSpecifier(binding.decl)) binding = resolveImport(project, binding);
    return functionOf(binding);
  }

  function returnLeaves(fn) {
    if (fn.asteriskToken) return [fn];
    return all(returnedExpressions(fn));
  }

  function callbackLeaves(arg) {
    if (!arg) return [];
    const a = unwrap(arg);
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return returnLeaves(a);
    if (ts.isIdentifier(a)) {
      const fn = functionOf(resolve(a));
      return fn ? returnLeaves(fn) : [a];
    }
    return [a];
  }

  function accessLeaves(e) {
    const name = lastName(e);
    if (name === 'length' || name === 'size' || (name && READ_BACK_MARKUP.has(name))) return [];
    const root = rootIdentifier(e);
    if (root && UPPER_CONST.test(root.text)) return [];
    const object = unwrap(e.expression);
    if (isConstantData(object) || isProducerValue(object)) return [];
    if (ts.isIdentifier(object)) {
      const binding = resolve(object);
      if (binding && ts.isParameter(binding.decl) && callbackOverConstant(binding.decl)) return [];
      if (binding && ts.isBindingElement(binding.decl) && bindingElementSafe(binding.decl)) return [];
      // `const o = { a: … }; o.a`: the property's own initializer (when `o` is never reassigned).
      if (binding && ts.isVariableDeclaration(binding.decl) && name && ts.isPropertyAccessExpression(e)) {
        const init = binding.decl.initializer && unwrap(binding.decl.initializer);
        if (init && ts.isObjectLiteralExpression(init) && !assignedValues(binding).length) {
          const prop = init.properties.find(p => propertyName(p) === name);
          if (prop && ts.isPropertyAssignment(prop)) return leaves(prop.initializer);
        }
      }
    }
    return [e];
  }

  /**
   * A trusted producer's value (vocab.producers calls such as the themer's getThemeVariables(), and the
   * vocab.tables such as `icons`), a fallback of one (`p() || {}`), or a const holding one: its properties are safe.
   */
  function isProducerValue(expression, depth = 0) {
    const e = unwrap(expression);
    if (!e || depth > 4) return false;
    if (ts.isCallExpression(e)) return vocab.producers?.has(calleeName(e) ?? '') || vocab.tables?.has(calleeName(e) ?? '') || false;
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
      return isProducerValue(e.left, depth + 1) && (isConstantData(e.right) || isProducerValue(e.right, depth + 1));
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      return vocab.tables?.has(lastName(e) ?? '') || isProducerValue(e.expression, depth + 1);
    }
    if (ts.isIdentifier(e)) {
      if (vocab.tables?.has(e.text)) return true;
      const binding = resolve(e);
      return Boolean(binding && ts.isVariableDeclaration(binding.decl) && (binding.decl.parent.flags & ts.NodeFlags.Const)
        && binding.decl.initializer && isProducerValue(binding.decl.initializer, depth + 1));
    }
    return false;
  }

  /** Leaves of the elements of an array-valued expression (for join, for-of and passthrough methods). */
  function elementLeaves(expression) {
    const e = unwrap(expression);
    if (elementMemo.has(e)) return elementMemo.get(e) ?? [];
    elementMemo.set(e, null);
    const result = computeElements(e);
    elementMemo.set(e, result);
    return result;
  }

  function computeElements(e) {
    if (isConstantData(e)) return [];
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap(el => ts.isSpreadElement(el) ? elementLeaves(el.expression) : leaves(el));
    }
    if (ts.isIdentifier(e)) {
      const binding = resolve(e);
      if (binding && ts.isVariableDeclaration(binding.decl) && binding.decl.initializer && !ts.isForOfStatement(binding.decl.parent.parent)) {
        const pushed = references(binding).flatMap(id => {
          const call = id.parent?.parent;
          return ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id && ts.isCallExpression(call)
            && call.expression === id.parent && ['push', 'unshift'].includes(id.parent.name.text) ? call.arguments : [];
        });
        return [...elementLeaves(binding.decl.initializer), ...all(assignedValues(binding).filter(v => !ts.isArrayLiteralExpression(unwrap(v)))
          .flatMap(v => elementLeaves(v))), ...all(pushed)];
      }
      return [e];
    }
    if (ts.isCallExpression(e)) {
      const name = calleeName(e);
      const receiver = receiverOf(e);
      if ((name === 'map' || name === 'flatMap') && receiver) return callbackLeaves(e.arguments[0]);
      if (name && receiver && ARRAY_PASSTHROUGH.has(name)) return [...elementLeaves(receiver), ...(name === 'concat' ? e.arguments.flatMap(a => elementLeaves(a)) : [])];
      if (name === 'split' && receiver) return leaves(receiver);
      if (name === 'from' && receiver && ts.isIdentifier(receiver) && receiver.text === 'Array') {
        return e.arguments[1] ? callbackLeaves(e.arguments[1]) : elementLeaves(e.arguments[0]);
      }
      const fn = calledFunction(e);
      if (fn) return returnedExpressions(fn).flatMap(x => elementLeaves(x));
    }
    return [e];
  }

  /** Constant data: literals and literal arrays/objects all the way down, UPPER constants, Object.keys of those. */
  const constMemo = new Map();
  function isConstantData(expression) {
    const e = unwrap(expression);
    if (!e) return true;
    if (constMemo.has(e)) return constMemo.get(e) ?? true;
    constMemo.set(e, null);
    let result = false;
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword
      || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword
      || ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isPrefixUnaryExpression(e)) result = true;
    else if (ts.isIdentifier(e)) {
      if (UPPER_CONST.test(e.text) || SAFE_GLOBALS.has(e.text)) result = true;
      else {
        let binding = resolve(e);
        if (binding && ts.isImportSpecifier(binding.decl)) binding = resolveImport(project, binding);
        result = Boolean(binding && ts.isVariableDeclaration(binding.decl) && (binding.decl.parent.flags & ts.NodeFlags.Const)
          && binding.decl.initializer && !ts.isForOfStatement(binding.decl.parent.parent) && isConstantData(binding.decl.initializer));
      }
    } else if (ts.isArrayLiteralExpression(e)) {
      result = e.elements.every(el => ts.isSpreadElement(el) ? isConstantData(el.expression) : isConstantData(el));
    } else if (ts.isObjectLiteralExpression(e)) {
      result = e.properties.every(p => ts.isPropertyAssignment(p) ? isConstantData(p.initializer)
        : ts.isMethodDeclaration(p) || (ts.isSpreadAssignment(p) && isConstantData(p.expression))
        || (ts.isShorthandPropertyAssignment(p) && isConstantData(p.name)));
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const root = rootIdentifier(e);
      result = Boolean(root && UPPER_CONST.test(root.text)) || isConstantData(e.expression);
    } else if (ts.isCallExpression(e)) {
      const name = calleeName(e);
      const receiver = receiverOf(e);
      if (receiver && ts.isIdentifier(receiver) && receiver.text === 'Object' && ['keys', 'values', 'entries'].includes(name)) result = isConstantData(e.arguments[0]);
      else if (receiver && name && ARRAY_PASSTHROUGH.has(name)) result = isConstantData(receiver);
    }
    constMemo.set(e, result);
    return result;
  }

  /** A parameter of a callback passed to an array method over constant data (`[…].map(x => …)`). */
  function callbackOverConstant(param) {
    const fn = param.parent;
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters[0] !== param) return false;
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
    const name = calleeName(call);
    const receiver = receiverOf(call);
    if (receiver && name && ELEMENT_CALLBACKS.has(name)) return isConstantData(receiver);
    return false;
  }

  /**
   * Caller contract: a parameter of a named function is safe when the function is only ever called directly and
   * every call site (in its file, or through a named import of it) passes a safe argument in that position.
   */
  function parameterSafe(param) {
    if (paramMemo.has(param)) return paramMemo.get(param) ?? true;
    paramMemo.set(param, null);
    const result = callbackOverConstant(param) || contractHolds(param);
    paramMemo.set(param, result);
    return result;
  }

  function contractHolds(param) {
    const fn = param.parent;
    if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
    const index = fn.parameters.indexOf(param);
    let nameNode = null;
    if (ts.isFunctionDeclaration(fn) && fn.name) nameNode = fn.name;
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) nameNode = fn.parent.name;
    if (!nameNode) return false;
    const binding = resolve(nameNode);
    if (!binding) return false;
    const refs = [...references(binding), ...(isExported(binding) ? importedReferences(project, binding) : [])];
    if (!refs.length) return false;
    for (const ref of refs) {
      if (ts.isExportSpecifier(ref.parent)) continue;
      const call = ref.parent;
      if (!ts.isCallExpression(call) || unwrap(call.expression) !== ref) return false;
      const args = call.arguments;
      if (args.slice(0, index + 1).some(a => ts.isSpreadElement(a))) return false;
      const arg = args[index];
      if (arg && leaves(arg).length) return false;
    }
    return true;
  }

  return { leaves, isConstantData };
}
