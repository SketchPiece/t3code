import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import type { HomeProjectScope } from "./homeThreadList";

/** Recent projects that get their own chip; the rest live in the "More" menu. */
const VISIBLE_PROJECT_CHIP_COUNT = 5;

/**
 * Project filter above the Home list, in the desktop sidebar's terms: the
 * list stays one flat list, and a chip narrows it to one project. The most
 * recent projects get chips; the rest stay reachable from "More". A selected
 * project also offers its path and a new-thread shortcut.
 */
export const HomeProjectChips = memo(function HomeProjectChips(props: {
  /** Sorted most recent first. */
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly activeCountByScopeKey: ReadonlyMap<string, number>;
  readonly totalActiveCount: number;
  readonly selectedScope: HomeProjectScope | null;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onNewThreadInProject: (scope: HomeProjectScope) => void;
}) {
  const { scopes, selectedScope, onProjectChange, onNewThreadInProject } = props;
  const chipScopes = useMemo(() => {
    const recent = scopes.slice(0, VISIBLE_PROJECT_CHIP_COUNT);
    // A project picked from "More" joins the row so the selection stays visible.
    return selectedScope !== null && !recent.some((scope) => scope.key === selectedScope.key)
      ? [selectedScope, ...recent.slice(0, VISIBLE_PROJECT_CHIP_COUNT - 1)]
      : recent;
  }, [scopes, selectedScope]);
  const moreActions = useMemo<MenuAction[]>(
    () =>
      scopes.map((scope) => ({
        id: scope.key,
        title: scope.title,
        subtitle: shortenHomePath(scope.representative.workspaceRoot),
        state: selectedScope?.key === scope.key ? "on" : "off",
      })),
    [scopes, selectedScope],
  );
  const handleMoreAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) =>
      onProjectChange(nativeEvent.event),
    [onProjectChange],
  );

  if (scopes.length < 2) return null;

  return (
    <View className="pb-1 pt-1">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-4 pb-2"
        keyboardShouldPersistTaps="handled"
      >
        <ProjectChip
          label="All"
          count={props.totalActiveCount}
          selected={selectedScope === null}
          onPress={() => onProjectChange(null)}
        />
        {chipScopes.map((scope) => (
          <ProjectChip
            key={scope.key}
            label={scope.title}
            count={props.activeCountByScopeKey.get(scope.key) ?? 0}
            selected={selectedScope?.key === scope.key}
            onPress={() => onProjectChange(selectedScope?.key === scope.key ? null : scope.key)}
            scope={scope}
          />
        ))}
        {scopes.length > VISIBLE_PROJECT_CHIP_COUNT ? (
          <ControlPillMenu actions={moreActions} onPressAction={handleMoreAction} title="Projects">
            <View
              accessibilityLabel={`All ${scopes.length} projects`}
              accessibilityRole="button"
              className="h-[34px] flex-row items-center gap-1.5 rounded-full bg-card px-3.5"
            >
              <Text className="text-sm font-t3-medium text-foreground-secondary">More</Text>
              <SymbolView
                name="chevron.down"
                size={10}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </View>
          </ControlPillMenu>
        ) : null}
      </ScrollView>
      {selectedScope !== null ? (
        <View className="flex-row items-center gap-2 px-5 pb-1">
          <Text
            className="flex-1 text-xs text-foreground-muted"
            numberOfLines={1}
            style={{ fontFamily: "Menlo" }}
          >
            {shortenHomePath(selectedScope.representative.workspaceRoot)}
          </Text>
          <Pressable
            accessibilityHint={`Starts a new thread in ${selectedScope.title}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onNewThreadInProject(selectedScope)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text className="text-sm font-t3-bold text-primary-text">+ New thread</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

function ProjectChip(props: {
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly scope?: HomeProjectScope;
}) {
  const project = props.scope?.representative;
  return (
    <Pressable
      accessibilityLabel={`${props.label}, ${props.count} active`}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={cn(
        "h-[34px] flex-row items-center gap-1.5 rounded-full",
        project ? "pl-1.5 pr-3" : "px-3.5",
        props.selected ? "bg-foreground" : "bg-card",
      )}
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {project ? (
        <ProjectFavicon
          environmentId={project.environmentId}
          faviconPath={project.faviconPath}
          projectIcon={project.projectIcon}
          size={22}
          projectTitle={props.label}
          workspaceRoot={project.workspaceRoot}
        />
      ) : null}
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-screen" : "text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.count > 0 ? (
        <Text
          className={cn(
            "text-xs tabular-nums opacity-60",
            props.selected ? "text-screen" : "text-foreground-secondary",
          )}
        >
          {props.count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** "/Users/me/Documents/x" → "~/Documents/x"; phones have no room for the home prefix. */
export function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
