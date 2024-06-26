// [rrandall] - TODO, remove this
// @ts-nocheck
import { AIConfigRuntime } from "./config";
import { InferenceSettings } from "../types";
import { JSONObject } from "../common";

export function getAPIKeyFromEnv(apiKeyName: string) {
  const apiKeyValue = process.env[apiKeyName];
  if (!apiKeyValue) {
    throw new Error(`Missing API key ${apiKeyName} in environment`);
  }
  return apiKeyValue;
}

export function extractOverrideSettings(
  configRuntime: AIConfigRuntime,
  inferenceSettings: InferenceSettings,
  modelName: string
) {
  const globalModelSettings: InferenceSettings = {
    ...(configRuntime.getGlobalSettings(modelName) ?? {}),
  };
  inferenceSettings = { ...(inferenceSettings ?? {}) };

  if (globalModelSettings != null) {
    // Check if the model settings from the input data are the same as the global model settings

    // Compute the difference between the global model settings and the model settings from the input data
    // If there is a difference, then we need to add the different model settings as overrides on the prompt's metadata
    const keys = union(
      Object.keys(globalModelSettings),
      Object.keys(inferenceSettings)
    );
    const overrides = keys.reduce(
      (result: JSONObject, key) => {
        if (!isEqual(globalModelSettings[key], inferenceSettings[key])) {
          result[key] = inferenceSettings[key];
        }
        return result;
      },
      {}
    );

    return overrides;
  }
  return inferenceSettings;
}

export function omit<T extends Record<string, any>>(obj: T, ...keysToOmit: (keyof T)[]): Partial<T> {
  // Create a new object to hold the result
  const result: Partial<T> = {};

  // Loop through each property in the original object
  for (const key in obj) {
    // Check if the property is a direct property of the object (not inherited)
    if (obj.hasOwnProperty(key) && !keysToOmit.includes(key)) {
      // If the key is not in the keysToOmit array, add it to the result object
      result[key] = obj[key];
    }
  }

  // Return the new object
  return result;
}

export function deepClone<T>(obj: T): T {
  // If obj is null or not an object, return it directly (base case)
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  // Handle Array objects
  if (Array.isArray(obj)) {
    const arrCopy = [] as any[];
    for (const item of obj) {
      arrCopy.push(deepClone(item));
    }
    return arrCopy as T;
  }

  // Handle plain objects
  const result = {} as { [key: string]: any };
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      result[key] = deepClone(obj[key]);
    }
  }

  return result as T;
}

export function generateUniqueId(length = 8) {
  // Characters to use in the unique ID
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  let result = '';

  // Generate a unique ID of the specified length
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charactersLength);
    result += characters[randomIndex];
  }

  return result;
}

// Adopted from: https://gist.github.com/guillotjulien/412974ac4731b9b95e2c1df6b3e97cb3
export function set<T extends object>(object: T, path: string, value: any): T {
  const decomposedPath = path.split('.');
  const base = decomposedPath[0] as keyof T;

  if (base === undefined) {
    return object;
  }

  // Assign an empty object if the base property doesn't exist
  if (!object.hasOwnProperty(base)) {
    object[base] = {} as any;
  }

  // Determine if there are still layers to traverse
  const newValue = decomposedPath.length <= 1 ? value : set(object[base] as any, decomposedPath.slice(1).join('.'), value);

  return {
    ...object,
    [base]: newValue,
  };
}

export function union<T>(...arrays: T[][]): T[] {
  const set = new Set<T>();

  arrays.forEach(array => {
    array.forEach(item => {
      set.add(item);
    });
  });

  return Array.from(set);
}

export function isEqual(first: any, second: any): boolean {
  if (first === second) {
    return true;
  }
  if ((first === undefined || second === undefined || first === null || second === null)
    && (first || second)) {
    return false;
  }
  const firstType = first?.constructor.name;
  const secondType = second?.constructor.name;
  if (firstType !== secondType) {
    return false;
  }
  if (firstType === 'Array') {
    if (first.length !== second.length) {
      return false;
    }
    let equal = true;
    for (let i = 0; i < first.length; i++) {
      if (!isEqual(first[i], second[i])) {
        equal = false;
        break;
      }
    }
    return equal;
  }
  if (firstType === 'Object') {
    let equal = true;
    const fKeys = Object.keys(first);
    const sKeys = Object.keys(second);
    if (fKeys.length !== sKeys.length) {
      return false;
    }
    for (let i = 0; i < fKeys.length; i++) {
      if (first[fKeys[i]] && second[fKeys[i]]) {
        if (first[fKeys[i]] === second[fKeys[i]]) {
          continue; // eslint-disable-line
        }
        if (first[fKeys[i]] && (first[fKeys[i]].constructor.name === 'Array'
          || first[fKeys[i]].constructor.name === 'Object')) {
          equal = isEqual(first[fKeys[i]], second[fKeys[i]]);
          if (!equal) {
            break;
          }
        } else if (first[fKeys[i]] !== second[fKeys[i]]) {
          equal = false;
          break;
        }
      } else if ((first[fKeys[i]] && !second[fKeys[i]]) || (!first[fKeys[i]] && second[fKeys[i]])) {
        equal = false;
        break;
      }
    }
    return equal;
  }
  return first === second;
};