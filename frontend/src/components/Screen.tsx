import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { BG } from "../config";

interface ScreenProps {
  children: ReactNode;
  edges?: readonly Edge[];
  // Allow content to extend under the keyboard / use a custom container.
  flat?: boolean;
}

export function Screen({ children, edges = ["top", "left", "right"], flat = false }: ScreenProps) {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={flat ? styles.flat : styles.body} edges={edges}>
        {children}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  body: {
    flex: 1,
    paddingHorizontal: 16,
  },
  flat: {
    flex: 1,
  },
});
