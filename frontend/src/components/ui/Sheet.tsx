/**
 * Sheet — thin wrapper over @gorhom/bottom-sheet's BottomSheetModal.
 *
 * Exposes a minimal forwarded ref so callers can call `.present()` /
 * `.dismiss()`. Theming applied via background + handle styling. Provider
 * (`BottomSheetModalProvider`) is mounted at the root in `app/_layout.tsx`.
 */
import React, { forwardRef, useCallback, useMemo } from "react";
import { View } from "react-native";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useThemeTokens } from "./tokens";

export interface SheetProps {
  snapPoints?: ReadonlyArray<string | number>;
  onChange?: (index: number) => void;
  enablePanDownToClose?: boolean;
  children?: React.ReactNode;
}

// Imperative handle so callers can present/dismiss without a sheet store.
export interface SheetHandle {
  present: () => void;
  dismiss: () => void;
}

export const Sheet = forwardRef<SheetHandle, SheetProps>(function Sheet(
  { snapPoints, onChange, enablePanDownToClose = true, children },
  ref,
) {
  const tokens = useThemeTokens();
  const innerRef = React.useRef<BottomSheetModal>(null);

  const points = useMemo(
    () => (snapPoints && snapPoints.length > 0 ? [...snapPoints] : ["40%"]),
    [snapPoints],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      present: () => innerRef.current?.present(),
      dismiss: () => innerRef.current?.dismiss(),
    }),
    [],
  );

  // Tappable scrim so users can dismiss by tapping outside the sheet.
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.4}
      />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={innerRef}
      snapPoints={points}
      onChange={onChange}
      enablePanDownToClose={enablePanDownToClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: tokens.surface }}
      handleStyle={{ paddingTop: 8, paddingBottom: 4 }}
      handleIndicatorStyle={{
        backgroundColor: tokens.line,
        width: 24,
        height: 4,
        borderRadius: 2,
      }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>{children}</View>
      </BottomSheetView>
    </BottomSheetModal>
  );
});
