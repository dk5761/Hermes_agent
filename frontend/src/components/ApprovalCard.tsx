import { useState, memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ACCENT, PANEL, TEXT } from "../config";
import { Button } from "./Button";
import { TextField } from "./TextField";
import type { ApprovalRequest } from "../state/chat-store";

interface Props {
  request: ApprovalRequest;
  onApproval: (requestId: string, choice: string, all?: boolean) => void;
  onClarify: (requestId: string, text: string) => void;
  onSudo: (requestId: string, choice: string) => void;
  onSecret: (requestId: string, value: string) => void;
}

function titleFor(kind: ApprovalRequest["kind"]): string {
  switch (kind) {
    case "approval":
      return "Approval requested";
    case "clarify":
      return "Clarification requested";
    case "sudo":
      return "Sudo requested";
    case "secret":
      return "Secret requested";
  }
}

function ApprovalCardInner({ request, onApproval, onClarify, onSudo, onSecret }: Props) {
  const [text, setText] = useState("");

  return (
    <View style={styles.row}>
      <View style={styles.card}>
        <Text style={styles.kind}>{titleFor(request.kind)}</Text>
        {request.prompt.length > 0 ? <Text style={styles.prompt}>{request.prompt}</Text> : null}

        {request.kind === "approval" ? (
          <View style={styles.actions}>
            <Button
              label="Allow"
              variant="primary"
              compact
              onPress={() => onApproval(request.requestId, "allow")}
            />
            <Button
              label="Allow all"
              variant="secondary"
              compact
              onPress={() => onApproval(request.requestId, "allow", true)}
            />
            <Button
              label="Deny"
              variant="danger"
              compact
              onPress={() => onApproval(request.requestId, "deny")}
            />
          </View>
        ) : null}

        {request.kind === "sudo" ? (
          <View style={styles.actions}>
            <Button
              label="Allow"
              variant="primary"
              compact
              onPress={() => onSudo(request.requestId, "allow")}
            />
            <Button
              label="Deny"
              variant="danger"
              compact
              onPress={() => onSudo(request.requestId, "deny")}
            />
          </View>
        ) : null}

        {request.kind === "clarify" ? (
          <View style={styles.inputBlock}>
            <TextField
              value={text}
              onChangeText={setText}
              placeholder="Your reply"
              multiline
            />
            <Button
              label="Send"
              variant="primary"
              compact
              disabled={text.trim().length === 0}
              onPress={() => onClarify(request.requestId, text.trim())}
            />
          </View>
        ) : null}

        {request.kind === "secret" ? (
          <View style={styles.inputBlock}>
            <TextField
              value={text}
              onChangeText={setText}
              placeholder="Secret value"
              secureTextEntry
            />
            <Button
              label="Submit"
              variant="primary"
              compact
              disabled={text.trim().length === 0}
              onPress={() => onSecret(request.requestId, text)}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

export const ApprovalCard = memo(ApprovalCardInner);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  card: {
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: ACCENT,
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  kind: {
    color: ACCENT,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  prompt: {
    color: TEXT,
    fontSize: 14,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  inputBlock: {
    gap: 8,
  },
});
