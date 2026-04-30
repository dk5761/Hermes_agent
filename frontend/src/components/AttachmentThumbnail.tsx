import { memo, useEffect, useState } from "react";
import { StyleSheet, View, Text } from "react-native";
import { Image } from "expo-image";
import { ensureThumb, getCachedThumbUri } from "../attachments/cache";
import { getAuthSnapshot } from "../auth/store";
import { BORDER, MUTED, PANEL } from "../config";

interface Props {
  attachmentId: string;
  // hasThumb=false skips the network fetch (e.g., very small images server
  // chose not to thumbnail); we still render the placeholder.
  hasThumb: boolean;
  size?: number;
}

function AttachmentThumbnailInner({ attachmentId, hasThumb, size = 160 }: Props) {
  const cached = getCachedThumbUri(attachmentId);
  const [uri, setUri] = useState<string | null>(cached);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (uri) return;
    if (!hasThumb) return;
    let cancelled = false;
    void (async () => {
      const token = getAuthSnapshot().accessToken;
      const localUri = await ensureThumb(attachmentId, token);
      if (cancelled) return;
      if (localUri) setUri(localUri);
      else setErrored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentId, hasThumb, uri]);

  const dim = { width: size, height: size };
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, dim]}
        contentFit="cover"
        cachePolicy="disk"
        transition={120}
      />
    );
  }
  return (
    <View style={[styles.placeholder, dim]}>
      <Text style={styles.placeholderText}>{errored ? "no thumb" : "..."}</Text>
    </View>
  );
}

export const AttachmentThumbnail = memo(AttachmentThumbnailInner);

const styles = StyleSheet.create({
  image: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: PANEL,
  },
  placeholder: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: PANEL,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: MUTED,
    fontSize: 11,
  },
});
