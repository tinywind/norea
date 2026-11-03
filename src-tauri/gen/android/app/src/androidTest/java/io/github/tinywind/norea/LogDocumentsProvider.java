package io.github.tinywind.norea;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

public class LogDocumentsProvider extends DocumentsProvider {
  public static final String AUTHORITY = "io.github.tinywind.norea.qalogs20261102.test.documents";
  private File root() {
    File root = new File(getContext().getFilesDir(), "log-documents");
    root.mkdirs();
    return root;
  }
  @Override public boolean onCreate() { return true; }
  private File file(String id) {
    File root = root();
    File file = "root".equals(id) ? root : new File(root, id.replaceFirst("^root/", ""));
    try {
      if (!file.getCanonicalPath().equals(root.getCanonicalPath()) && !file.getCanonicalPath().startsWith(root.getCanonicalPath() + "/")) {
        throw new IllegalArgumentException("Document escapes QA root");
      }
    } catch (IOException error) { throw new IllegalArgumentException(error); }
    return file;
  }
  @Override public Cursor queryRoots(String[] projection) {
    MatrixCursor cursor = new MatrixCursor(projection == null ? new String[] {Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS} : projection);
    MatrixCursor.RowBuilder row = cursor.newRow();
    for (String column : cursor.getColumnNames()) {
      Object value = null;
      if (Root.COLUMN_ROOT_ID.equals(column)) value = "logs";
      if (Root.COLUMN_DOCUMENT_ID.equals(column)) value = "root";
      if (Root.COLUMN_TITLE.equals(column)) value = "Isolated log QA documents";
      if (Root.COLUMN_FLAGS.equals(column)) value = Root.FLAG_SUPPORTS_CREATE | Root.FLAG_LOCAL_ONLY;
      row.add(column, value);
    }
    return cursor;
  }
  private MatrixCursor cursor(String[] projection) {
    return new MatrixCursor(projection == null ? new String[] {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_FLAGS} : projection);
  }
  private void add(MatrixCursor cursor, String id) {
    File target = file(id);
    MatrixCursor.RowBuilder row = cursor.newRow();
    for (String column : cursor.getColumnNames()) {
      Object value = null;
      if (Document.COLUMN_DOCUMENT_ID.equals(column)) value = id;
      if (Document.COLUMN_DISPLAY_NAME.equals(column)) value = target.getName();
      if (Document.COLUMN_MIME_TYPE.equals(column)) value = target.isDirectory() ? Document.MIME_TYPE_DIR : "text/plain";
      if (Document.COLUMN_SIZE.equals(column)) value = target.length();
      if (Document.COLUMN_FLAGS.equals(column)) value = Document.FLAG_SUPPORTS_WRITE | Document.FLAG_SUPPORTS_DELETE |
        (target.isDirectory() ? Document.FLAG_DIR_SUPPORTS_CREATE : 0);
      row.add(column, value);
    }
  }
  @Override public Cursor queryDocument(String id, String[] projection) {
    MatrixCursor cursor = cursor(projection);
    add(cursor, id);
    return cursor;
  }
  @Override public Cursor queryChildDocuments(String parent, String[] projection, String sortOrder) {
    MatrixCursor cursor = cursor(projection);
    File[] children = file(parent).listFiles();
    if (children != null) for (File child : children) add(cursor, parent + "/" + child.getName());
    return cursor;
  }
  @Override public String createDocument(String parent, String mime, String name) throws FileNotFoundException {
    if (name.contains("/") || name.equals(".") || name.equals("..")) throw new IllegalArgumentException("Invalid QA document name");
    String id = parent + "/" + name;
    File file = file(id);
    try {
      if (!(Document.MIME_TYPE_DIR.equals(mime) ? file.mkdir() : file.createNewFile())) throw new IOException("QA document exists");
    } catch (IOException error) { throw new FileNotFoundException(error.toString()); }
    return id;
  }
  @Override public void deleteDocument(String id) throws FileNotFoundException {
    if (!file(id).delete()) throw new FileNotFoundException("QA document deletion failed");
  }
  @Override public boolean isChildDocument(String parent, String id) { return id.startsWith(parent + "/"); }
  @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
    return ParcelFileDescriptor.open(file(id), ParcelFileDescriptor.parseMode(mode));
  }
}
