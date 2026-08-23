ALTER TABLE `chapter` ADD COLUMN `stored_content_type` text;
--> statement-breakpoint
UPDATE `chapter`
SET `stored_content_type` =
  CASE `content_type`
    WHEN 'text' THEN 'html'
    WHEN 'markdown' THEN 'html'
    ELSE `content_type`
  END
WHERE `is_downloaded` = 1;
