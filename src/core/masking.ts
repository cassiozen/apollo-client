import { Kind } from "graphql";
import type {
  FragmentDefinitionNode,
  InlineFragmentNode,
  SelectionSetNode,
} from "graphql";
import {
  createFragmentMap,
  getMainDefinition,
  resultKeyNameFromField,
  isUnmaskedDocument,
  getFragmentDefinitions,
} from "../utilities/index.js";
import type { FragmentMap } from "../utilities/index.js";
import type { DocumentNode, TypedDocumentNode } from "./index.js";
import { invariant } from "../utilities/globals/index.js";

type MatchesFragmentFn = (
  fragmentNode: InlineFragmentNode,
  typename: string
) => boolean;

export function maskQuery<TData = unknown>(
  data: TData,
  document: TypedDocumentNode<TData> | DocumentNode,
  matchesFragment: MatchesFragmentFn
): TData {
  const definition = getMainDefinition(document);
  const fragmentMap = createFragmentMap(getFragmentDefinitions(document));
  const [masked, changed] = maskSelectionSet(
    data,
    definition.selectionSet,
    matchesFragment,
    fragmentMap,
    isUnmaskedDocument(document)
  );

  return changed ? masked : data;
}

export function maskFragment<TData = unknown>(
  data: TData,
  document: TypedDocumentNode<TData> | DocumentNode,
  matchesFragment: MatchesFragmentFn,
  fragmentName?: string
): TData {
  const fragments = document.definitions.filter(
    (node): node is FragmentDefinitionNode =>
      node.kind === Kind.FRAGMENT_DEFINITION
  );

  const fragmentMap = createFragmentMap(getFragmentDefinitions(document));

  if (typeof fragmentName === "undefined") {
    invariant(
      fragments.length === 1,
      `Found %s fragments. \`fragmentName\` must be provided when there is not exactly 1 fragment.`,
      fragments.length
    );
    fragmentName = fragments[0].name.value;
  }

  const fragment = fragments.find(
    (fragment) => fragment.name.value === fragmentName
  );

  invariant(
    !!fragment,
    `Could not find fragment with name "%s".`,
    fragmentName
  );

  const [masked, changed] = maskSelectionSet(
    data,
    fragment.selectionSet,
    matchesFragment,
    fragmentMap,
    false
  );

  return changed ? masked : data;
}

function maskSelectionSet(
  data: any,
  selectionSet: SelectionSetNode,
  matchesFragment: MatchesFragmentFn,
  fragmentMap: FragmentMap,
  isUnmasked: boolean
): [data: any, changed: boolean] {
  if (Array.isArray(data)) {
    let changed = false;

    const masked = data.map((item) => {
      const [masked, itemChanged] = maskSelectionSet(
        item,
        selectionSet,
        matchesFragment,
        fragmentMap,
        isUnmasked
      );
      changed ||= itemChanged;

      return itemChanged ? masked : item;
    });

    return [changed ? masked : data, changed];
  }

  return selectionSet.selections.reduce<[any, boolean]>(
    ([memo, changed], selection) => {
      switch (selection.kind) {
        case Kind.FIELD: {
          const keyName = resultKeyNameFromField(selection);
          const descriptor = Object.getOwnPropertyDescriptor(memo, keyName);
          const childSelectionSet = selection.selectionSet;

          // If we've set a descriptor on the object by adding warnings to field
          // access, overwrite the descriptor because we're adding a field that
          // is accessible when masked. This checks avoids the need for us to
          // maintain which fields are masked/unmasked and better handle
          if (descriptor) {
            Object.defineProperty(memo, keyName, { value: data[keyName] });
          } else {
            memo[keyName] = data[keyName];
          }

          if (childSelectionSet) {
            const [masked, childChanged] = maskSelectionSet(
              data[keyName],
              childSelectionSet,
              matchesFragment,
              fragmentMap,
              isUnmasked
            );

            if (childChanged) {
              memo[keyName] = masked;
              changed = true;
            }
          }

          return [memo, changed];
        }
        case Kind.INLINE_FRAGMENT: {
          if (
            selection.typeCondition &&
            !matchesFragment(selection, data.__typename)
          ) {
            return [memo, changed];
          }

          const [fragmentData, childChanged] = maskSelectionSet(
            data,
            selection.selectionSet,
            matchesFragment,
            fragmentMap,
            isUnmasked
          );

          return [
            {
              ...memo,
              ...fragmentData,
            },
            changed || childChanged,
          ];
        }
        default:
          const fragment = fragmentMap[selection.name.value];

          return [
            isUnmasked ?
              addAccessorWarnings(memo, data, fragment.selectionSet)
            : memo,
            true,
          ];
      }
    },
    [Object.create(null), false]
  );
}

function addAccessorWarnings(
  memo: Record<string, unknown>,
  parent: Record<string, unknown>,
  selectionSetNode: SelectionSetNode
) {
  selectionSetNode.selections.forEach((selection) => {
    switch (selection.kind) {
      case Kind.FIELD: {
        const keyName = resultKeyNameFromField(selection);

        if (keyName in memo) {
          return;
        }

        return addAccessorWarning(memo, parent[keyName], keyName);
      }
    }
  });

  return memo;
}

function addAccessorWarning(
  data: Record<string, any>,
  value: any,
  fieldName: string
) {
  let currentValue = value;
  let warned = false;

  Object.defineProperty(data, fieldName, {
    get() {
      if (!warned) {
        invariant.warn(
          "Accessing unmasked field '%s' on query %s. This field will not be available when masking is enabled. Please read the field from the fragment instead.",
          fieldName
        );
        warned = true;
      }

      return currentValue;
    },
    set(value) {
      currentValue = value;
    },
    enumerable: true,
    configurable: true,
  });
}
