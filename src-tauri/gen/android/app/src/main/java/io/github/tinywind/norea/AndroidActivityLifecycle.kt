package io.github.tinywind.norea

import androidx.annotation.Keep

@Keep
object AndroidActivityLifecycle {
  @JvmStatic
  external fun publish(activityId: Int, resumed: Boolean)

  @JvmStatic
  external fun publishDestruction(activityId: Int, completed: Boolean)
}
