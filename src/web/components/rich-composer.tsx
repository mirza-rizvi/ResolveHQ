import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface RichComposerHandle {
  insertText: (text: string) => void;
}

interface RichComposerProps {
  value: string;
  html?: string;
  onChange: (text: string, html: string) => void;
  onSubmit: () => void;
  placeholder: string;
  ref?: Ref<RichComposerHandle>;
}

export function RichComposer({ value, html, onChange, onSubmit, placeholder, ref }: RichComposerProps) {
  // The text the editor itself last produced. Only a `value` that differs from
  // it came from outside (a ticket switch, a cleared draft), and only that is
  // worth reloading into the document — echoing back every keystroke would
  // reset the selection and flatten formatting as the agent types.
  const lastEmitted = useRef(value);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, blockquote: false, horizontalRule: false }),
      Placeholder.configure({ placeholder }),
    ],
    // Rich markup is only available when the caller kept it; a stored draft
    // comes back as text and is rebuilt from paragraphs.
    content: html || (value ? textToHtml(value) : ""),
    editorProps: {
      attributes: {
        class: "rich-composer-editor",
        role: "textbox",
        "aria-label": "Reply message",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      const text = current.getText({ blockSeparator: "\n" });
      lastEmitted.current = text;
      onChange(text, current.getHTML());
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      // Saved replies are inserted at the cursor, so surrounding formatting and
      // anything already typed survive the insert.
      insertText: (text: string) => {
        if (!editor || editor.isDestroyed) return;
        editor.chain().focus().insertContent(textToHtml(text)).run();
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state.doc) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value ? textToHtml(value) : "", { emitUpdate: false });
  }, [editor, value]);

  if (!editor || editor.isDestroyed) return <div className="rich-composer-loading" aria-label="Loading editor" />;
  return (
    <div className="rich-composer-field">
      <div className="rich-composer-toolbar" role="toolbar" aria-label="Text formatting">
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          aria-label="Italic"
          aria-pressed={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} />
        </button>
        <button
          type="button"
          aria-label="Bulleted list"
          aria-pressed={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={15} />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function textToHtml(value: string) {
  return value
    .split("\n\n")
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
