import { HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import {
  activityBackgroundTint,
  background,
  clipShape,
  font,
  foregroundStyle,
  frame,
  kerning,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  shadow,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

// Helm fork: replaces src/widgets/AgentActivity.tsx (see ../metro.cjs) with
// layout A: whoever waits on you leads, large; everyone else follows as a lamp,
// a title and a timer the system ticks by itself. Props are upstream's.

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// Serialized into the widget extension's JS bundle: keep it self-contained.
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;
  const monochrome =
    environment.widgetRenderingMode === "accented" || environment.widgetRenderingMode === "vibrant";
  const light = environment.colorScheme === "light";

  // Bakelite lamps: amber waits for approval, lavender for an answer, teal works,
  // green is done, red failed. Light variants for Mac's light presentation.
  const tint = (phase: AgentActivityPhase | undefined): Foreground => {
    if (environment.isLuminanceReduced) return secondary;
    if (monochrome) return primary;
    switch (phase) {
      case "waiting_for_approval":
        return light ? "#9C6A1B" : "#F2B550";
      case "waiting_for_input":
        return light ? "#6B55B8" : "#B9A6EF";
      case "failed":
        return light ? "#B8321F" : "#EA7862";
      case "completed":
        return light ? "#3E7A2E" : "#8FC56A";
      default:
        return light ? "#257A73" : "#6FC9C1";
    }
  };
  const lampColor = (phase: AgentActivityPhase) => String(tint(phase));

  const phaseLabel = (phase: AgentActivityPhase): string => {
    switch (phase) {
      case "waiting_for_approval":
        return "Ждёт разрешения";
      case "waiting_for_input":
        return "Ждёт ответа";
      case "failed":
        return "Ошибка";
      case "completed":
        return "Готово";
      case "starting":
        return "Запускается";
      case "stale":
        return "Нет обновлений";
      default:
        return "Работает";
    }
  };

  const waits = (row: AgentActivityRowProps) =>
    row.phase === "waiting_for_approval" || row.phase === "waiting_for_input";
  const priority = (row: AgentActivityRowProps) =>
    waits(row)
      ? 0
      : row.phase === "failed"
        ? 1
        : row.phase === "running" || row.phase === "starting"
          ? 2
          : 3;
  const ordered = [...props.activities].sort((a, b) => priority(a) - priority(b));
  const hero = ordered.find((row) => waits(row) || row.phase === "failed");
  const rest = ordered.filter((row) => row !== hero);
  const waiting = props.activities.filter(waits).length;
  const working = props.activities.filter(
    (row) => row.phase === "running" || row.phase === "starting",
  ).length;
  const allDone = props.activeCount === 0;
  const failed = props.activities.some((row) => row.phase === "failed");

  const deepLinkRow = hero ?? ordered[0];
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;

  const lamp = (phase: AgentActivityPhase, size = 7) => (
    <HStack
      modifiers={[
        frame({ width: size, height: size }),
        foregroundStyle(tint(phase)),
        // Lamps that still burn glow; finished ones sit flat.
        ...(!monochrome && phase !== "completed" && phase !== "stale"
          ? [shadow({ radius: 3, color: lampColor(phase) })]
          : []),
      ]}
    >
      <Image systemName="circle.fill" modifiers={[resizable()]} />
    </HStack>
  );
  // The square screen: bakelite tile with the amber signal (template asset).
  const mark = (size: number) => (
    <ZStack
      modifiers={[
        frame({ width: size, height: size }),
        background(monochrome ? "#00000000" : "#26211D"),
        clipShape("roundedRectangle", size * 0.24),
      ]}
    >
      <HStack
        modifiers={[
          frame({ width: size * 0.72, height: size * 0.48 }),
          foregroundStyle(monochrome ? primary : "#E8A33D"),
        ]}
      >
        <Image assetName="T3Mark" modifiers={[resizable()]} />
      </HStack>
    </ZStack>
  );
  const since = (row: AgentActivityRowProps) => {
    const date = new Date(row.updatedAt);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const trailing = (row: AgentActivityRowProps) => {
    const start = since(row);
    if ((row.phase === "running" || row.phase === "starting") && start) {
      return (
        <Text
          date={start}
          dateStyle="timer"
          modifiers={[
            font({ design: "monospaced", size: 13 }),
            foregroundStyle(secondary),
            layoutPriority(1),
          ]}
        />
      );
    }
    return (
      <Text
        modifiers={[
          font({ weight: "medium", size: 12 }),
          foregroundStyle(tint(row.phase)),
          layoutPriority(1),
        ]}
      >
        {phaseLabel(row.phase).toLowerCase()}
      </Text>
    );
  };
  const row = (item: AgentActivityRowProps) => (
    <HStack spacing={9} alignment="center">
      {lamp(item.phase)}
      <Text modifiers={[font({ size: 14 }), foregroundStyle(primary), lineLimit(1)]}>
        {item.threadTitle}
      </Text>
      <Spacer minLength={8} />
      {trailing(item)}
    </HStack>
  );
  const heroBlock = (item: AgentActivityRowProps, titleSize: number) => (
    <VStack alignment="leading" spacing={4}>
      <HStack spacing={7} alignment="center">
        {lamp(item.phase)}
        <Text
          modifiers={[
            font({ design: "monospaced", weight: "medium", size: 11 }),
            kerning(1.2),
            foregroundStyle(tint(item.phase)),
            lineLimit(1),
          ]}
        >
          {`${phaseLabel(item.phase).toUpperCase()} · ${item.projectTitle.toUpperCase()}`}
        </Text>
      </HStack>
      <Text
        modifiers={[
          font({ weight: "semibold", size: titleSize }),
          foregroundStyle(primary),
          lineLimit(2),
        ]}
      >
        {item.threadTitle}
      </Text>
      <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}>
        {item.phase === "failed" ? item.status : item.modelTitle}
      </Text>
    </VStack>
  );
  const counts = (
    <HStack spacing={10} alignment="center">
      {allDone ? (
        <Text
          modifiers={[
            font({ weight: "medium", size: 12 }),
            foregroundStyle(tint(failed ? "failed" : "completed")),
          ]}
        >
          {failed ? "есть ошибка" : "✓ готово"}
        </Text>
      ) : null}
      {!allDone && waiting > 0 ? (
        <Text
          modifiers={[
            font({ design: "monospaced", weight: "medium", size: 12 }),
            foregroundStyle(tint("waiting_for_approval")),
          ]}
        >
          {`● ${waiting}`}
        </Text>
      ) : null}
      {!allDone && working > 0 ? (
        <Text
          modifiers={[
            font({ design: "monospaced", weight: "medium", size: 12 }),
            foregroundStyle(tint("running")),
          ]}
        >
          {`● ${working}`}
        </Text>
      ) : null}
    </HStack>
  );
  const header = (
    <HStack spacing={8} alignment="center">
      {mark(18)}
      <Text modifiers={[font({ weight: "semibold", size: 13 }), foregroundStyle(primary)]}>
        Штурвал
      </Text>
      <Spacer minLength={6} />
      {counts}
    </HStack>
  );
  const heroTint = tint(hero?.phase ?? (allDone ? (failed ? "failed" : "completed") : "running"));
  const compactLabel = hero
    ? phaseLabel(hero.phase)
    : allDone
      ? failed
        ? "Ошибка"
        : "Готово"
      : `${working}`;

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[
          padding({ all: 14 }),
          activityBackgroundTint(monochrome ? null : "#161310"),
          ...(deepLink ? [widgetURL(deepLink)] : []),
        ]}
      >
        {header}
        {hero ? heroBlock(hero, 17) : null}
        {rest[0] ? row(rest[0]) : null}
        {rest[1] ? row(rest[1]) : null}
        {rest[2] ? row(rest[2]) : null}
        {!hero && rest[3] ? row(rest[3]) : null}
      </VStack>
    ),
    bannerSmall: (
      <VStack alignment="leading" spacing={5} modifiers={[padding({ all: 10 })]}>
        <HStack spacing={7} alignment="center">
          {mark(16)}
          <Text
            modifiers={[
              font({ weight: "semibold", size: 12 }),
              foregroundStyle(heroTint),
              lineLimit(1),
            ]}
          >
            {compactLabel}
          </Text>
        </HStack>
        {(hero ?? ordered[0]) ? (
          <Text
            modifiers={[
              font({ weight: "semibold", size: 12 }),
              foregroundStyle(primary),
              lineLimit(2),
            ]}
          >
            {(hero ?? ordered[0])!.threadTitle}
          </Text>
        ) : null}
      </VStack>
    ),
    compactLeading: mark(20),
    compactTrailing: (
      <HStack spacing={5} alignment="center">
        {lamp(hero?.phase ?? (allDone ? (failed ? "failed" : "completed") : "running"))}
        <Text modifiers={[font({ weight: "semibold", size: 12 }), foregroundStyle(heroTint)]}>
          {compactLabel}
        </Text>
      </HStack>
    ),
    minimal: lamp(hero?.phase ?? (allDone ? (failed ? "failed" : "completed") : "running"), 11),
    expandedLeading: <HStack modifiers={[padding({ leading: 4, vertical: 4 })]}>{mark(20)}</HStack>,
    expandedCenter: null,
    expandedTrailing: <HStack modifiers={[padding({ trailing: 6, vertical: 4 })]}>{counts}</HStack>,
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={7}
        modifiers={
          deepLink
            ? [padding({ vertical: 2, horizontal: 8 }), widgetURL(deepLink)]
            : [padding({ vertical: 2, horizontal: 8 })]
        }
      >
        {hero ? heroBlock(hero, 15) : null}
        {rest[0] ? row(rest[0]) : null}
        {rest[1] ? row(rest[1]) : null}
        {!hero && rest[2] ? row(rest[2]) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
