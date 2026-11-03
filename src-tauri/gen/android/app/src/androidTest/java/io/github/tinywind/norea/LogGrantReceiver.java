package io.github.tinywind.norea;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;

public class LogGrantReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    String target = "io.github.tinywind.norea.qalogs20261102.debug";
    Uri tree = DocumentsContract.buildTreeDocumentUri(LogDocumentsProvider.AUTHORITY, "root");
    int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    if ("io.github.tinywind.norea.qalogs.GRANT".equals(intent.getAction())) {
      context.grantUriPermission(target, tree, flags | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    } else if ("io.github.tinywind.norea.qalogs.REVOKE".equals(intent.getAction())) {
      context.revokeUriPermission(target, tree, flags);
    } else return;
    setResultData("ok");
  }
}
