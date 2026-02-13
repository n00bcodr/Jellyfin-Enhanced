## Troubleshooting

### Links Not Appearing

**Check Configuration:**
1. Verify *arr URLs are correct
2. Ensure "Enable *arr Links" is checked
3. Confirm you're logged in as administrator
4. Check item has *arr metadata

**Test URLs:**
- Open *arr URLs in browser
- Verify they're accessible from Jellyfin server
- Check for HTTPS/HTTP mismatches

### Tags Not Syncing

**Check API Keys:**
1. Verify API keys are correct
2. Test API access manually
3. Check *arr logs for errors

**Check Tag Settings:**
- Verify tag prefix matches *arr tags
- Check sync filter isn't too restrictive
- Ensure tags exist in *arr

### Calendar Not Loading

**Check Prerequisites:**
1. Sonarr/Radarr URLs configured
2. API keys entered
3. *arr instances accessible
4. Calendar page enabled

**Check Logs:**
- Browser console for client errors
- Server logs for API errors
- *arr logs for connection issues

### Requests Page Issues

**Downloads Not Showing:**
1. Verify polling is enabled
2. Check poll interval setting
3. Ensure downloads exist in *arr
4. Check API connectivity

**Status Not Updating:**
1. Verify polling is enabled
2. Check poll interval
3. Refresh page manually
4. Check browser console for errors


## Support

If you encounter issues:

1. Check [FAQ](faq.md) for common solutions
2. Verify *arr URLs and API keys
3. Check browser console and server logs
4. Report issues on [GitHub](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)