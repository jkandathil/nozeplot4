import React from 'react';
import { UploadCloud, FileSpreadsheet } from 'lucide-react';
import { motion } from 'framer-motion';
import './EmptyState.css';

const EmptyState = ({ isDragActive, hasFiles }) => {
    return (
        <div className={`empty-state ${isDragActive ? 'active' : ''}`}>
            <motion.div
                className="content"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <div className="icon-wrapper">
                    {hasFiles ? (
                        <FileSpreadsheet size={64} color="var(--accent-secondary)" />
                    ) : (
                        <UploadCloud size={64} className="upload-icon" />
                    )}
                </div>

                <h2>
                    {hasFiles
                        ? "Select a file from the sidebar"
                        : "Drag & Drop CSV Files or Folders"}
                </h2>

                <p className="description">
                    {hasFiles
                        ? "Visualize your data"
                        : "Supports .csv, .txt, .xlsx (coming soon). Folder upload supported."}
                </p>

                {!hasFiles && (
                    <div className="cta-button">
                        Browse Files
                    </div>
                )}
            </motion.div>
        </div>
    );
};

export default EmptyState;
