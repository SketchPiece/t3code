import type { EnvironmentId } from "@t3tools/contracts";
import { Modal, Platform, Pressable, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { ComposerEditor, type ComposerEditorProps } from "../../components/ComposerEditor";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/** A draft this long reads better on its own screen: the composer offers ⤢. */
export function composerDraftWantsFullscreen(text: string): boolean {
  return text.length > 280 || text.split("\n").length > 6;
}

/**
 * The composer's draft on a whole sheet, for reading and editing a long dictation.
 * Edits go to the same draft; swiping the sheet down or ⤡ returns to the composer.
 */
export function ComposerFullscreenEditor(props: {
  readonly visible: boolean;
  readonly draftKey: string;
  readonly environmentId?: EnvironmentId;
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly skills: ComposerEditorProps["skills"];
  readonly placeholder?: string;
  readonly sendLabel: string;
  readonly canSend: boolean;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange: (selection: ComposerEditorSelection) => void;
  readonly onSend: () => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  return (
    <Modal
      visible={props.visible}
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-sheet-solid"
        style={{
          paddingTop: Platform.OS === "android" ? insets.top : 0,
          paddingBottom: insets.bottom,
        }}
      >
        <View className="flex-row items-center px-4 pt-3 pb-2">
          <View className="size-[44px]" />
          <View className="min-w-0 flex-1 items-center">
            <Text className="font-t3-bold text-base text-foreground">Message</Text>
            <Text className="text-xs text-foreground-muted">
              {`${props.value.length} characters`}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Back to the composer"
            accessibilityRole="button"
            className="size-[44px] items-center justify-center active:opacity-70"
            onPress={props.onClose}
          >
            <SymbolView
              name="arrow.down.right.and.arrow.up.left"
              size={17}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </Pressable>
        </View>
        <View className="min-h-0 flex-1 px-5">
          <ComposerEditor
            draftKey={props.draftKey}
            environmentId={props.environmentId}
            multiline
            scrollEnabled
            autoFocus
            value={props.value}
            selection={props.selection}
            skills={props.skills}
            placeholder={props.placeholder}
            onChangeText={props.onChangeText}
            onSelectionChange={props.onSelectionChange}
            style={{ flex: 1 }}
            textStyle={{ ...bodyText, color: foregroundColor }}
          />
        </View>
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View className="flex-row items-center justify-end border-t border-border px-2 py-1">
            <ComposerActionButton
              accessibilityLabel={props.sendLabel}
              disabled={!props.canSend}
              icon="arrow.up"
              onPress={() => {
                props.onClose();
                props.onSend();
              }}
              variant="primary"
            />
          </View>
        </KeyboardStickyView>
      </View>
    </Modal>
  );
}
