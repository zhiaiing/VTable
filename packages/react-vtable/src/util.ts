import { isNil, isArray, isString, isFunction, isPlainObject, isEqual } from '@visactor/vutils';
import type { ReactNode } from 'react';
import React from 'react';
import { isFragment } from 'react-is';

let id = 0;

export const uid = (prefix?: string) => {
  if (prefix) {
    return `${prefix}-${id++}`;
  }

  return `${id++}`;
};

/**
 * Get the display name of a component
 * @param  {Object} Comp Specified Component
 * @return {String}      Display name of Component
 */
export const getDisplayName = (Comp: any) => {
  if (typeof Comp === 'string') {
    return Comp;
  }
  if (!Comp) {
    return '';
  }
  return Comp.displayName || Comp.name;
};

export const typeOfComponent = (component: any, customTypeKey = '__TYPE'): string => {
  return (
    (component?.props && component.props[customTypeKey]) ||
    (typeof component?.type === 'string' && component.type) ||
    (component?.type &&
      typeof component.type === 'symbol' &&
      component.type.toString() === 'Symbol(react.fragment)' &&
      'react.fragment') ||
    (typeof component?.type === 'function' && component.type) ||
    (typeof component?.type === 'object' &&
      component.type.$$typeof.toString() === 'Symbol(react.forward_ref)' &&
      'react.forward_ref') ||
    (typeof component === 'string' && 'string') ||
    (typeof component === 'function' && 'function') ||
    undefined
  );
};

export const toArray = <T = ReactNode, TC = ReactNode>(children: T): TC[] => {
  let result: TC[] = [];

  React.Children.forEach(children, child => {
    if (isNil(child)) {
      return;
    }

    if (isFragment(child)) {
      result = result.concat(toArray(child.props.children));
    } else {
      result.push(child as unknown as TC);
    }
  });

  return result;
};

/*
 * Find and return all matched children by type. `type` can be a React element class or
 * string
 */
export const findAllByType = <T extends React.ReactNode, TC = unknown>(
  children: React.ReactNode,
  type: TC | TC[]
): T[] => {
  const result: T[] = [];
  let types: string[] = [];

  if (isArray(type)) {
    types = type.map(t => getDisplayName(t));
  } else {
    types = [getDisplayName(type)];
  }

  toArray(children).forEach(child => {
    const childType = getDisplayName(typeOfComponent(child));

    if (types.indexOf(childType) !== -1) {
      result.push(child as T);
    }
  });

  return result;
};
/*
 * Return the first matched child by type, return null otherwise.
 * `type` can be a React element class or string.
 */
export const findChildByType = <T extends React.ReactNode, TC = unknown>(children: React.ReactNode, type: TC): T => {
  const result = findAllByType<T, TC>(children, type);

  return result?.[0];
};

function objToString(obj: any) {
  return Object.prototype.toString.call(obj);
}

function objectKeys(obj: any) {
  return Object.keys(obj);
}

export function isEqualRecords(a: any, b: any, options?: { skipFunction?: boolean }): boolean {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  // null 和 undefined
  if (a == null || b == null) {
    return false;
  }

  // 特殊处理NaN
  if (Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }

  if (objToString(a) !== objToString(b)) {
    return false;
  }

  // 如果是function，则不相等
  if (isFunction(a)) {
    return !!options?.skipFunction;
  }

  // 值类型，Number String Boolean
  if (typeof a !== 'object') {
    return false;
  }

  if (isArray(a)) {
    if (a.length !== b.length) {
      return false;
    }

    return a === b;
  }

  if (!isPlainObject(a)) {
    return false;
  }

  const ka = objectKeys(a);
  const kb = objectKeys(b);
  // having the same number of owned properties (keys incorporates hasOwnProperty)
  if (ka.length !== kb.length) {
    return false;
  }

  // the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  // ~~~cheap key test
  for (let i = ka.length - 1; i >= 0; i--) {
    // eslint-disable-next-line eqeqeq
    if (ka[i] != kb[i]) {
      return false;
    }
  }

  // equivalent values for every corresponding key, and ~~~possibly expensive deep test
  for (let i = ka.length - 1; i >= 0; i--) {
    const key = ka[i];
    if (!isEqual(a[key], b[key], options)) {
      return false;
    }
  }

  return true;
}