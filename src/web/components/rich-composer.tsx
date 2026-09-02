import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List } from "lucide-react";
import { useEffect } from "react";

interface RichComposerProps {
  value: string;
  onChange: (text: string, html: string) => void;
  onSubmit: () => void;
  placeholder: string;
}

export function RichComposer({ value, onChange, onSubmit, placeholder }: RichComposerProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, blockquote: false, horizontalRule: false }), Placeholder.configure({ placeholder })],
    content: value ? `<p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>` : "",
    editorProps: {
      attributes: { class: "rich-composer-editor", role: "textbox", "aria-label": "Reply message", "aria-multiline": "true" },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); onSubmit(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getText({ blockSeparator: "\n" }), current.getHTML()),
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state.doc || editor.getText({ blockSeparator: "\n" }) === value) return;
    editor.commands.setContent(value ? `<p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>` : "", { emitUpdate: false });
  }, [editor, value]);

  if (!editor || editor.isDestroyed) return <div className="rich-composer-loading" aria-label="Loading editor" />;
  return <div className="rich-composer-field">
    <div className="rich-composer-toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" aria-label="Bold" aria-pressed={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></button>
      <button type="button" aria-label="Italic" aria-pressed={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
      <button type="button" aria-label="Bulleted list" aria-pressed={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></button>
    </div>
    <EditorContent editor={editor} />
  </div>;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
