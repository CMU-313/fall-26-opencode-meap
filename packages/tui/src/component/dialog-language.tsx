import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Chinese",
  "Japanese",
  "Korean",
  "Hindi",
  "Arabic",
  "Russian",
  "Vietnamese",
  "Indonesian",
  "Turkish",
]

export function DialogLanguage() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  return (
    <DialogSelect
      title="Response language"
      options={LANGUAGES.map((value) => ({ title: value, value }))}
      current={sync.data.config.language ?? "English"}
      onSelect={(opt) => {
        dialog.clear()
        sdk.client.global.config
          .update({ config: { language: opt.value } }, { throwOnError: true })
          .then(() => toast.show({ message: `Responses will be in ${opt.value}`, variant: "info" }))
          .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
      }}
    />
  )
}
