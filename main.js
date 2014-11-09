/*
 * Copyright (c) 2014 Torin Pascal. All rights reserved.
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, brackets, $ */

define(function (require, exports, module) {
    "use strict";

    // Brackets modules
    var AppInit                     = brackets.getModule("utils/AppInit"),
        ProjectManager              = brackets.getModule("project/ProjectManager"),
        CommandManager              = brackets.getModule("command/CommandManager"),
        Menus                       = brackets.getModule("command/Menus"),
        FileUtils                   = brackets.getModule("file/FileUtils"),
        DefaultDialogs              = brackets.getModule("widgets/DefaultDialogs"),
        Dialogs                     = brackets.getModule("widgets/Dialogs");

    var MODULE_NAME                 = "Duplicate";

    var MENU_CMD_DUPLICATE          = "project-menu.duplicate";
    var MENU_CMD_MARK               = "project-menu.mark";
    var MENU_CMD_MOVE               = "project-menu.move";
    var MENU_CMD_COPY               = "project-menu.copy";
    var MENU_ITEM_DUPLICATE         = "Duplicate";
    var MENU_ITEM_MARK              = "Mark";
    var MENU_ITEM_MOVE              = "Move to Here";
    var MENU_ITEM_COPY              = "Copy to Here";
    
    var SUFFIX                      = " copy";
    
    var cmdDuplicate, cmdMark, cmdMove, cmdCopy;
    
    var markedItem = null;

    
    function showErrorMessage(msg) {
        Dialogs.showModalDialog(DefaultDialogs.DIALOG_ID_ERROR, MODULE_NAME, msg);
    }
    
    function canonicalizeDirectoryPath(path) {
        if (path && path.length) {
            var lastChar = path[path.length - 1];
            if (lastChar !== "/") {
                path += "/";
            }
        }
        return path;
    }

    function getFilenameFromPath(path) {
        return FileUtils.getBaseName(path);
    }
    
    function copyFile(dst, src) {
        var promise = new $.Deferred();

        brackets.fs.stat(dst, function (err, stats) {
            if (err === brackets.fs.ERR_NOT_FOUND ||
                (err === brackets.fs.NO_ERROR && !stats.isDirectory())) {
                brackets.fs.copyFile(src, dst, function (err) {
                    if (err === brackets.fs.NO_ERROR) {
                        promise.resolve();
                    } else {
                        // unable to write file
                        promise.reject(err);
                    }
                });
            } else if (err === brackets.fs.NO_ERROR) {
                if (stats.isDirectory()) {
                    promise.reject(brackets.fs.ERR_CANT_WRITE);
                } else {
                    promise.reject(brackets.fs.ERR_FILE_EXISTS);
                }
            } else {
                promise.reject(err);
            }
        });

        return promise;
    }

    function copyFileToDir(dstDir, srcFile) {
        var promise = new $.Deferred(),
            dstFile = canonicalizeDirectoryPath(dstDir) + getFilenameFromPath(srcFile);
        
        return copyFile(dstFile, srcFile);
    }

    function copyDirectory(dst, src) {
        var i,
            completeCount = 0,
            errorCount = 0,
            promise = new $.Deferred();

        if (!src || !dst) {
            return promise.resolve(0);
        }

        brackets.fs.readdir(src, function (err, fileList) {
            if (err === brackets.fs.NO_ERROR) {
                var failHandler = function () {
                    ++errorCount;
                };
                var alwaysHandler = function () {
                    if (++completeCount === fileList.length) {
                        promise.resolve(errorCount);
                    }
                };

                var doCopy = function (dst, src) {
                    brackets.fs.stat(src, function (err, stats) {
                        if (stats.isFile()) {
                            copyFileToDir(dst, src)
                            .fail(failHandler)
                            .always(alwaysHandler);
                        } else if (stats.isDirectory()) {
                            dst = canonicalizeDirectoryPath(dst) + getFilenameFromPath(src);
                            brackets.fs.makedir(dst, 777, function (err) {
                                if (err === brackets.fs.NO_ERROR) {
                                    copyDirectory(dst, src)
                                    .fail(failHandler)
                                    .always(alwaysHandler);
                                } else {
                                    ++errorCount;
                                }
                            });
                        }
                    });
                };

                for (i = 0; i < fileList.length; i++) {
                    doCopy(dst, canonicalizeDirectoryPath(src) + fileList[i]);
                }

                // avoid race condition on empty folder                
                if (fileList.length === 0) {
                    promise.resolve(0);
                }

            } else if (err === brackets.fs.ERR_NOT_FOUND) {
                promise.resolve(0);
            } else {
                promise.reject(err);
            }
        });

        return promise;
    }

    function duplicateDirectory(dst, src) {
        var promise = new $.Deferred();
        brackets.fs.makedir(dst, 777, function (err) {
            if (err === brackets.fs.NO_ERROR) {
                copyDirectory(dst, src)
                .done(function (errorCount) {
                    if (errorCount && errorCount > 0) {
                        showErrorMessage("Failed to copy files.");
                        promise.reject();
                    } else {
                        promise.resolve();
                    }
                })
                .fail(function (err) {
                    showErrorMessage(err);
                    promise.reject(err);
                });

            } else {
                showErrorMessage(err);
                promise.reject(err);
            }
        });
        return promise;
    }
    
    /*
        Given the target name, file or directory, it will call fs.stat to
        determine if the target name exists already. If so, it will add
        a suffix sequence number that increments until it find one that does
        not exist.
    */
    function findUniqueName(target, seq, isDir, func) {
        var tmp = addSuffix(target, seq, isDir);
        
        brackets.fs.stat(tmp, function (err, stats) {
            if (err === brackets.fs.ERR_NOT_FOUND) {
                func(brackets.fs.NO_ERROR, tmp);
            } else if (err === brackets.fs.NO_ERROR) {
                findUniqueName(target, ++seq, isDir, func);
            } else {
                func(err, null);
            }
        });
    }
    
    function addSuffix(filename, seq, isDir) {
        
        var ext = isDir ? "" : FileUtils.getSmartFileExtension(filename);
        var sfx = seq < 0 ? "" : (seq > 0 ? (SUFFIX + " " + seq) : SUFFIX);
        
        if (ext === "") {
            filename += sfx;
        } else {
            filename = FileUtils.getFilenameWithoutExtension(filename) + sfx + "." + ext;
        }
        
        return filename;
    }

    function doDuplicate() {
        var src, dst;
        var selectedItem = ProjectManager.getSelectedItem();
        
        if (selectedItem._isDirectory) {
            
            src = selectedItem._path;
            dst = selectedItem._parentPath + selectedItem._name;
            
            findUniqueName(dst, 0, true, function (err, dstUnique) {
                if (err === brackets.fs.NO_ERROR) {
                    duplicateDirectory(dstUnique, src);
                } else {
                    showErrorMessage("Unable to duplicate directory (err=" + err + ").");
                }
            });
            
        } else if (selectedItem._isFile) {

            src = selectedItem._path;
            dst = selectedItem._parentPath + selectedItem._name;

            findUniqueName(dst, 0, false, function (err, dstUnique) {
                if (err === brackets.fs.NO_ERROR) {
                    copyFile(dstUnique, src);
                } else {
                    showErrorMessage("Unable to duplicate file (err=" + err + ").");
                }
            });
        }
    }
    
    function doMark() {
        var src, dst;
        
        markedItem = ProjectManager.getSelectedItem();
        
        //console.log("Marked : " + markedItem);
        
        itemMarked(true);
    }
    
    function doMove() {
        doCopyMove(true);
    }
    
    function doCopy() {
        doCopyMove(false);
    }
    
    function doCopyMove(move) {
        var src, dst, dstPath;
        var selectedItem = ProjectManager.getSelectedItem();
        
        if (markedItem === null)
            return;

        // determine destination parent path
        if (selectedItem._isDirectory) {
            dstPath = selectedItem._path;
        } else {
            dstPath = selectedItem._parentPath;
        }
        
        // determine new destination path
        dst = canonicalizeDirectoryPath(dstPath) + markedItem._name;

        src = markedItem._path;

        //console.log("CopyMove Source : " + src);
        //console.log("CopyMove Destination : " + dst);

        if (markedItem._isDirectory) {
            
            findUniqueName(dst, -1, true, function (err, dstUnique) {
                if (err === brackets.fs.NO_ERROR) {
                    duplicateDirectory(dstUnique, src)
                    .done(function (errCount) {
                        // delete source if moving
                        if (move) {
                            ProjectManager.deleteItem(markedItem);
                        }
                    })
                    .fail(function (err) {
                        showErrorMessage("Unable to copy/move directory (err=" + err + ").");
                    })
                    .always(function (err) {
                        // completed; clear mark
                        markedItem = null;
                        itemMarked(false);
                    });
                } else {
                    showErrorMessage("Unable to duplicate directory (err=" + err + ").");
                }
            });

        } else {
            
            findUniqueName(dst, -1, false, function (err, dstUnique) {
                if (err === brackets.fs.NO_ERROR) {
                    copyFile(dstUnique, src)
                    .done(function (errCount) {
                        // delete source if moving
                        if (move) {
                            //console.log("Moved - deleting [" + markedItem._path + "]");
                            ProjectManager.deleteItem(markedItem);
                        }
                    })
                    .fail(function (err) {
                        showErrorMessage("Unable to copy/move file (err=" + err + ").");
                    })
                    .always(function (err) {
                        // completed; clear mark
                        markedItem = null;
                        itemMarked(false);
                    });
                } else {
                    showErrorMessage("Unable to copy/move file (err=" + err + ").");
                }
            });
            
        }
    }
    
    function itemMarked(marked) {
        cmdMove.setEnabled(marked);
        cmdCopy.setEnabled(marked);
    }

    // Initialize extension once shell is finished initializing.
    AppInit.appReady(function () {
        
        // Add to project context menu
        cmdDuplicate = CommandManager.register(MENU_ITEM_DUPLICATE, MENU_CMD_DUPLICATE, doDuplicate);
        cmdMark = CommandManager.register(MENU_ITEM_MARK, MENU_CMD_MARK, doMark);
        cmdMove = CommandManager.register(MENU_ITEM_MOVE, MENU_CMD_MOVE, doMove);
        cmdCopy = CommandManager.register(MENU_ITEM_COPY, MENU_CMD_COPY, doCopy);
        
        var menu = Menus.getContextMenu(Menus.ContextMenuIds.PROJECT_MENU);

        menu.addMenuItem(MENU_CMD_DUPLICATE);
        menu.addMenuItem(MENU_CMD_MARK);
        menu.addMenuItem(MENU_CMD_MOVE);
        menu.addMenuItem(MENU_CMD_COPY);
        
        markedItem = null;
        itemMarked(false);
        
        // dump all registered commands
        //console.log(JSON.stringify(CommandManager.getAll()));
        
    });
    
});

