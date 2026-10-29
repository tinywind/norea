package io.github.tinywind.norea

import android.content.res.Resources
import android.net.Uri
import org.json.JSONObject

private val SCRIPT_PLACEHOLDER = Regex("""__NOREA_[A-Z_]+__""")

/**
 * JavaScript the scraper bridge injects into plugin WebViews, read once from
 * `res/raw`. Template placeholders are filled in a single pass so request
 * values are embedded verbatim and never rescanned for other placeholders.
 */
internal class AndroidScraperScripts(resources: Resources) {
  private val initTemplate: String = resources.rawScript(R.raw.norea_scraper_init)
  val clearExtractBridge: String = resources.rawScript(R.raw.norea_scraper_clear_extract)
  private val fetchTemplate: String = resources.rawScript(R.raw.norea_scraper_fetch)
  private val extractStartTemplate: String = resources.rawScript(R.raw.norea_scraper_extract_start)

  fun init(appUrl: String?): String = fillScriptTemplate(
    initTemplate,
    mapOf("__NOREA_APP_ORIGIN_JSON__" to appOriginJson(appUrl)),
  )

  fun fetch(id: String, nonce: String, request: JSONObject): String =
    fillScriptTemplate(
      fetchTemplate,
      mapOf(
        "__NOREA_REQUEST_JSON__" to request.toString(),
        "__NOREA_REQUEST_ID_JSON__" to JSONObject.quote(id),
        "__NOREA_REQUEST_NONCE_JSON__" to JSONObject.quote(nonce),
      ),
    )

  fun extractStart(id: String, nonce: String, beforeScript: String, appUrl: String?): String =
    fillScriptTemplate(
      extractStartTemplate,
      mapOf(
        "__NOREA_REQUEST_ID_JSON__" to JSONObject.quote(id),
        "__NOREA_REQUEST_NONCE_JSON__" to JSONObject.quote(nonce),
        "__NOREA_BEFORE_SCRIPT__" to beforeScript,
        "__NOREA_APP_ORIGIN_JSON__" to appOriginJson(appUrl),
      ),
    )
}

private fun appOriginJson(appUrl: String?): String =
  appUrl?.let { originUrl(Uri.parse(it)) }?.let(JSONObject::quote) ?: "null"

private fun Resources.rawScript(id: Int): String =
  openRawResource(id).bufferedReader().use { it.readText() }

private fun fillScriptTemplate(template: String, values: Map<String, String>): String =
  SCRIPT_PLACEHOLDER.replace(template) { match -> values.getValue(match.value) }
